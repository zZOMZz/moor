import test from 'node:test';
import { githubWriteRequestVersion } from '../src/web/github-write';
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
test('actual write app reviews exact lines and commits, persists manual drafts, and only inspects unknown operations', async () => {
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
    features: [
      'session-actions',
      'git-worktree-v1',
      'session-fork-v1',
      'github-read-v1',
      'github-write-v1',
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
  let writePhase: 'accepted' | 'unknown' = 'unknown',
    wrongWrite = false;
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
      else if (url.pathname.endsWith('/github-write/read')) {
        const common = {
          githubWriteVersion: 1,
          workspaceId: body.workspaceId,
          localProjectId: body.localProjectId,
          sessionId: body.sessionId,
          confirmed: true,
          view: body.view,
          readAt: timestamp,
        };
        if (body.view === 'overview')
          result = {
            ...common,
            repository,
            configVersion: version,
            writesEnabled: true,
            bindingRevision: 0,
            git: {
              kind: 'git',
              branch: 'topic',
              headOid: oid,
              branches: [{ name: 'topic', oid }],
              changes: [{ path: 'README.md', index: ' ', worktree: 'M' }],
              dirty: true,
              partial: false,
              outsideProjectChanges: false,
              version,
              issues: [],
              writeSupported: true,
            },
            execution: { mode: 'shared', status: 'ready', revision: 0 },
            canCommit: true,
          };
        else if (body.view === 'commit-preview')
          result = {
            ...common,
            candidateVersion: version,
            branch: 'topic',
            parentOid: oid,
            indexVersion: version,
            files: body.paths.map((path: string) => ({
              path,
              kind: 'modify',
              version,
              byteLength: 3,
              mode: '100644',
              beforeText: 'old',
              afterText: 'new <img src=x>',
              binary: false,
              truncated: false,
            })),
            execution: { mode: 'shared', status: 'ready', revision: 0 },
          };
        else if (body.view === 'files')
          result = {
            ...common,
            repository,
            configVersion: version,
            writesEnabled: true,
            bindingRevision: 0,
            number: body.number,
            headSha: body.headSha,
            baseSha: body.baseSha,
            result: {
              page: body.page,
              hasNext: false,
              partial: false,
              items: [
                {
                  path: 'README.md',
                  sha: oid,
                  status: 'modified',
                  additions: 1,
                  deletions: 1,
                  changes: 2,
                  patch: '@@ -1,2 +1,2 @@\n kept\n-old\n+new <img src=x>',
                  patchTruncated: false,
                  version,
                },
              ],
            },
          };
        else assert.fail('Unexpected write read ' + body.view);
      } else if (/\/github-write\/(action|inspect|abandon)$/.test(url.pathname)) {
        const request = body.request ?? body;
        const stored = [...storage.values()].find(
          (v: any) => v?.pending?.request?.operationId === request.operationId,
        ) as any;
        assert.ok(stored);
        assert.deepEqual(stored.pending.request, request);
        result = {
          githubWriteVersion: 1,
          workspaceId: request.workspaceId,
          localProjectId: request.localProjectId,
          sessionId: request.sessionId,
          operationId: request.operationId,
          action: request.action,
          requestVersion: wrongWrite
            ? 'sha256:' + 'e'.repeat(64)
            : await githubWriteRequestVersion(request),
          phase: writePhase,
          confirmed: writePhase === 'accepted',
          ...(writePhase === 'accepted'
            ? {
                result:
                  request.action === 'commit' || request.action === 'push'
                    ? { sha: oid }
                    : request.action === 'pr-merge'
                      ? { number: request.number }
                      : { id: 901, number: request.number ?? 3 },
              }
            : {}),
          message: 'Synthetic write outcome',
          checkedAt: timestamp,
        };
      } else if (url.pathname.endsWith('/github/read')) {
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
  const directory = await mkdtemp(join(process.cwd(), 'dist/tests/github-write-app-')),
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
        name: 'synthetic-github-write-boundaries',
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
                ? 'export const read=async key=>structuredClone(globalThis.__moorAppCache.get(key));export const write=async(key,value)=>{globalThis.__moorAppCache.set(key,structuredClone(value));};export const compareWrite=async(key,expectedRevision,value,current)=>{if(!current())throw new Error("stale Git target");const cache=globalThis.__moorAppCache;if((cache.get(key)?.cacheRevision??0)!==expectedRevision)return false;cache.set(key,structuredClone(value));return true;}; export const clear=async()=>globalThis.__moorAppCache.clear();'
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
              '\nexport {openGithub,openGithubWrite,currentGithubWrite,openSession,sendTurn};export {disposeUI} from "./ui";',
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
  const writes = () => requests.filter((v) => v.path.endsWith('/github-write/action'));
  const inspections = () => requests.filter((v) => v.path.endsWith('/github-write/inspect'));
  const stableKey =
    'attachment-session-v1/' + JSON.stringify([owner, device.id, runtime.id, 'local-project']);
  storage.set(stableKey, 'independent-write-draft');
  async function fill(label: string, value: string) {
    await act(async () => {
      const element = [...document.querySelectorAll<HTMLLabelElement>('.github-write-editor label')]
        .find((v) => v.textContent?.startsWith(label))
        ?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea');
      assert.ok(element, label);
      const proto =
        element.tagName === 'TEXTAREA'
          ? win.HTMLTextAreaElement.prototype
          : win.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
      element.dispatchEvent(new win.Event('input', { bubbles: true }));
      await (globalThis as any).__moorLastOperation;
    });
  }
  try {
    await act(() =>
      app.boot(Promise.resolve({ owner, needsSetup: false }), Promise.resolve(owner)),
    );
    await act(() => SyntheticSocket.instances.at(-1)!.open());
    await act(async () => await (globalThis as any).__moorLastOperation);
    await click('GitHub 仓库与会话上下文');
    await click('读取 PRs');
    await click('#8 Synthetic fork PRopen · synthetic');
    await click('审查、评论与发布');
    assert.match(document.querySelector('.github-write-panel')!.textContent!, /contributor\/fork/);
    assert.equal(button('使用当前 PR 内容创建编辑草稿').disabled, true);
    assert.match(document.querySelector('.github-write-panel')!.textContent!, /不能在此覆盖编辑/);
    await click('读取 PR 文件 Diff');
    await act(() => document.querySelector<HTMLElement>('.github-write-file summary')!.click());
    assert.equal(document.querySelector('.github-write-diff img'), null);
    await click('评论 README.md 新文件第 2 行');
    await fill('待发布正文', 'My explicit line comment <script>text only</script>');
    const lineId = Object.keys(app.currentGithubWrite().drafts)[0];
    assert.equal(
      app.currentGithubWrite().drafts[lineId].values.body,
      'My explicit line comment <script>text only</script>',
    );
    assert.equal(writes().length, 0);
    await click('审查本次操作');
    assert.match(
      document.querySelector('[aria-label="最终写入确认"]')!.textContent!,
      /README.md · 新文件 第 2 行/,
    );
    assert.equal(document.querySelector('[aria-label="最终写入确认"] script'), null);
    assert.equal(writes().length, 0);
    await click('确认发布行评论');
    assert.equal(writes().length, 1);
    const originalLine = structuredClone(writes()[0]!.body);
    assert.equal(originalLine.line, 2);
    assert.equal(originalLine.headSha, oid);
    assert.equal(originalLine.baseSha, pull.base.sha);
    assert.equal(originalLine.path, 'README.md');
    assert.ok(app.currentGithubWrite().pending);
    assert.equal(app.currentGithubWrite().blocksExecution, false);
    assert.equal(field().value, draft);
    await click('关闭写入面板');
    const before = writes().length;
    await act(() => app.openSession(''));
    assert.equal(app.currentGithubWrite().target.sessionId, 'independent-write-draft');
    assert.equal(Object.keys(app.currentGithubWrite().drafts).length, 0);
    await act(() => app.openSession(sessionId));
    assert.deepEqual(app.currentGithubWrite().pending.request, originalLine);
    assert.equal(writes().length, before);
    await act(() => app.openGithubWrite());
    writePhase = 'accepted';
    await click('核查原操作结果');
    assert.deepEqual(inspections()[0].body, { request: originalLine, page: 1 });
    assert.equal(writes().length, 1);
    assert.equal(app.currentGithubWrite().pending, undefined);
    const checkbox = [...document.querySelectorAll<HTMLLabelElement>('.github-write-panel label')]
      .find((v) => v.textContent?.includes('README.md'))
      ?.querySelector<HTMLInputElement>('input[type=checkbox]');
    assert.ok(checkbox);
    await act(() => checkbox.click());
    await click('预览选中文件');
    assert.equal(writes().length, 1);
    await click('编写提交说明');
    await fill('提交说明', 'test: selected synthetic change');
    await fill('提交作者姓名', 'Synthetic');
    await fill('提交作者邮箱', 'synthetic@example.invalid');
    await click('审查本次操作');
    assert.match(document.querySelector('[aria-label="最终写入确认"]')!.textContent!, /父提交/);
    assert.match(
      document.querySelector('[aria-label="最终写入确认"]')!.textContent!,
      /test: selected synthetic change/,
    );
    writePhase = 'unknown';
    await click('确认提交选中文件');
    assert.equal(writes().length, 2);
    const originalCommit = structuredClone(writes()[1]!.body);
    assert.deepEqual(originalCommit.paths, ['README.md']);
    assert.equal(app.currentGithubWrite().blocksExecution, true);
    assert.equal(document.querySelector<HTMLButtonElement>('#send')!.disabled, true);
    assert.equal(field().value, draft);
    await click('关闭写入面板');
    await act(() => app.openSession(''));
    assert.equal(app.currentGithubWrite().blocksExecution, false);
    await act(() => app.openSession(sessionId));
    assert.equal(app.currentGithubWrite().blocksExecution, true);
    assert.equal(writes().length, 2);
    await act(() => app.openGithubWrite());
    wrongWrite = true;
    await click('核查原操作结果');
    assert.ok(app.currentGithubWrite().pending);
    wrongWrite = false;
    const endCheckbox = () =>
      [...document.querySelectorAll<HTMLLabelElement>('.github-write-panel label')]
        .find((value) => value.textContent?.includes('结束核查；'))
        ?.querySelector<HTMLInputElement>('input[type=checkbox]');
    await act(() => endCheckbox()!.click());
    assert.equal(endCheckbox()!.checked, true);
    writePhase = 'accepted';
    await click('核查原操作结果');
    assert.equal(app.currentGithubWrite().pending, undefined);
    assert.equal(app.currentGithubWrite().blocksExecution, false);
    assert.equal(writes().length, 2);
    assert.ok(
      inspections()
        .slice(1)
        .every((v) => JSON.stringify(v.body.request) === JSON.stringify(originalCommit)),
    );
    await act(() => {
      const select = [...document.querySelectorAll<HTMLLabelElement>('.github-write-panel label')]
        .find((value) => value.textContent?.startsWith('已保存的手工草稿'))!
        .querySelector<HTMLSelectElement>('select')!;
      select.value = lineId;
      select.dispatchEvent(new win.Event('change', { bubbles: true }));
    });
    writePhase = 'unknown';
    await click('审查本次操作');
    await click('确认发布行评论');
    assert.notEqual(
      app.currentGithubWrite().pending.request.operationId,
      originalCommit.operationId,
    );
    assert.equal(endCheckbox()!.checked, false);
    assert.equal(button('结束原操作核查').disabled, true);
    writePhase = 'accepted';
    await click('核查原操作结果');
    assert.equal(writes().length, 3);
    const savedDrafts = structuredClone(app.currentGithubWrite().drafts);
    await act(() => SyntheticSocket.instances.at(-1)!.onclose?.());
    assert.equal(app.currentGithubWrite().overview, undefined);
    assert.equal(app.currentGithubWrite().files, undefined);
    assert.deepEqual(app.currentGithubWrite().drafts, savedDrafts);
    assert.equal(requests.filter((v) => v.path.endsWith('/mutations')).length, 0);
    assert.doesNotMatch(
      JSON.stringify([...storage.entries()].filter(([key]) => key.startsWith('github-write-v1/'))),
      /Private issue body|Private comment|new <img src=x>/,
    );
  } finally {
    await act(() => app.disposeUI());
    dom.window.close();
    await rm(directory, { recursive: true, force: true });
  }
});
