import assert from 'node:assert/strict';
import type { SecureCliTarget } from '@moor/client/secure-operation';
import { SecureStore, type SecureStorageBackend } from '../../apps/web/src/platform/secure-store';
import {
  SecureScopedStorage,
  secureGitTarget,
} from '../../apps/web/src/platform/secure-scoped-storage';
import {
  SecureGithubController,
  type SecureGithubContext,
  type SecureGithubMethod,
} from '../../apps/web/src/features/github/secure-github';
import {
  githubWriteKey,
  githubWriteRequestVersion,
} from '../../apps/web/src/features/github/github-write';
import { githubKey } from '../../apps/web/src/features/github/github';
import type { GithubBinding } from '@moor/protocol/github-protocol';

export const target: SecureCliTarget = {
  origin: 'https://relay.synthetic.invalid',
  owner: 'owner',
  rootKeyId: 'A'.repeat(43),
  clientDeviceId: 'client',
  hostDeviceId: 'host',
  workspaceId: 'runtime',
  localProjectId: 'local',
  userId: 'user',
  machineId: 'machine',
  sessionId: 'session',
  product: {
    catalogWorkspaceId: 'catalog',
    projectId: 'product',
    replicaId: 'replica',
    revision: 1,
  },
};
export const version = 'sha256:' + 'a'.repeat(64),
  head = 'b'.repeat(40),
  base = 'c'.repeat(40),
  date = '2026-09-13T00:00:00Z';
export const repository = {
  id: 42,
  owner: 'example',
  name: 'synthetic',
  private: true,
  defaultBranch: 'main',
  url: 'https://github.com/example/synthetic',
};
export function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
export class Memory implements SecureStorageBackend {
  values = new Map<string, unknown>();
  locks = new Map<string, Promise<void>>();
  beforeRead?: (key: string) => Promise<void>;
  beforeWrite?: (key: string) => Promise<void>;
  queued?: (key: string) => void;
  async read(key: string) {
    await this.beforeRead?.(key);
    return structuredClone(this.values.get(key) ?? null);
  }
  async compareAndSet(key: string, expected: unknown, value: unknown, current: () => void) {
    await this.beforeWrite?.(key);
    current();
    assert.deepEqual(this.values.get(key) ?? null, expected, 'CAS conflict');
    this.values.set(key, structuredClone(value));
  }
  async exclusive<T>(key: string, current: () => void, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve(),
      release = signal();
    this.locks.set(key, release.promise);
    this.queued?.(key);
    await previous;
    try {
      current();
      return await task();
    } finally {
      release.resolve();
      if (this.locks.get(key) === release.promise) this.locks.delete(key);
    }
  }
}
export function fixture(memory = new Memory()) {
  const store = new SecureStore(memory),
    storage = new SecureScopedStorage(store);
  const state = {
    context: {
      target: structuredClone(target),
      online: true,
      generation: 1,
    } as SecureGithubContext,
    readAt: date,
    lost: false,
    phase: 'accepted' as 'accepted' | 'unknown',
    released: false,
    wrong: false,
    appended: 'Unsent local draft',
    beforeWriteCount: 0,
    changedCount: 0,
    beforeChanged: undefined as undefined | (() => Promise<void>),
    beforeWrite: undefined as undefined | (() => Promise<void>),
    beforeAppend: undefined as undefined | (() => Promise<void>),
    beforeResponse: undefined as
      | undefined
      | ((method: SecureGithubMethod, params: any) => Promise<void>),
    binding: { revision: 0 } as GithubBinding,
  };
  const item = {
    id: 99,
    number: 2,
    title: 'Synthetic private PR title',
    state: 'open',
    author: 'synthetic',
    url: repository.url + '/pull/2',
    updatedAt: date,
    body: 'Synthetic provider body <script>external()</script> ![track](https://invalid.test/pixel)',
    bodyTruncated: false,
    labels: [],
    version,
    kind: 'pull',
    head: {
      sha: head,
      branch: 'topic',
      repository: { id: 43, owner: 'contributor', name: 'fork' },
    },
    base: {
      sha: base,
      branch: 'main',
      repository: { id: 42, owner: repository.owner, name: repository.name },
    },
    mergeable: null,
  };
  const file = {
    path: 'README.md',
    sha: head,
    status: 'modified',
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: '@@ -1,2 +1,2 @@\n kept\n-old\n+new',
    patchTruncated: false,
    version,
  };
  const comment = {
    id: 71,
    author: 'reviewer',
    body: 'Synthetic remote thread',
    bodyTruncated: false,
    url: repository.url + '/pull/2#discussion_r71',
    updatedAt: date,
    path: 'README.md',
    commitSha: head,
    originalCommitSha: head,
    side: 'RIGHT',
    line: 2,
    originalLine: 2,
    version,
  };
  const branches = [
    { name: 'topic', sha: head, protected: false },
    { name: 'main', sha: base, protected: true },
  ];
  const calls: { target: SecureCliTarget; method: SecureGithubMethod; params: any }[] = [];
  let counter = 0;
  const deps = {
    context: () => state.context,
    storage,
    uuid: () => `operation-${++counter}`,
    changed: async (_target: SecureCliTarget, current: () => void) => {
      await state.beforeChanged?.();
      current();
      state.changedCount++;
    },
    beforeWrite: async (_target: SecureCliTarget, current: () => void) => {
      state.beforeWriteCount++;
      await state.beforeWrite?.();
      current();
    },
    appendInstruction: async (original: SecureCliTarget, text: string, current: () => void) => {
      await state.beforeAppend?.();
      current();
      assert.deepEqual(original, state.context.target);
      state.appended += '\n\n' + text;
    },
    request: async (
      original: SecureCliTarget,
      method: SecureGithubMethod,
      params: unknown,
      current: () => void,
    ): Promise<unknown> => {
      current();
      const r = structuredClone(params) as any;
      calls.push({ target: structuredClone(original), method, params: r });
      const scope = {
        workspaceId: original.workspaceId,
        localProjectId: original.localProjectId,
        sessionId: original.sessionId,
      };
      const page = (items: unknown[]) => ({
        page: r.page,
        partial: false,
        hasNext: r.page === 1,
        items,
      });
      await state.beforeResponse?.(method, r);
      current();
      if (method === 'github-read') {
        const common = {
          ...scope,
          githubVersion: 1,
          confirmed: true,
          view: r.view,
          readAt: state.readAt,
          repository,
          configVersion: version,
          binding: structuredClone(state.binding),
        };
        if (r.view === 'overview')
          return { ...common, status: 'available', localBranch: 'topic', localHeadSha: head };
        if (r.view === 'branches') return { ...common, result: page(branches) };
        if (r.view === 'pull' || r.view === 'issue') {
          if (r.view === 'pull') return { ...common, item: structuredClone(item) };
          const { head: _h, base: _b, mergeable: _m, ...issue } = item;
          return {
            ...common,
            item: {
              ...issue,
              kind: 'issue',
              number: r.number,
              url: repository.url + '/issues/' + r.number,
            },
          };
        }
        if (r.view === 'pulls' || r.view === 'issues')
          return {
            ...common,
            state: r.state,
            result: page([
              {
                id: 99,
                number: 2,
                title: item.title,
                state: 'open',
                author: 'synthetic',
                url: item.url,
                updatedAt: date,
                kind: r.view === 'pulls' ? 'pull' : 'issue',
              },
            ]),
          };
        if (r.view === 'comments')
          return {
            ...common,
            subject: r.subject,
            number: r.number,
            result: page([
              {
                id: 71,
                author: 'synthetic',
                body: comment.body,
                bodyTruncated: false,
                url: comment.url,
                updatedAt: date,
              },
            ]),
          };
        if (r.view === 'checks')
          return {
            ...common,
            number: r.number,
            headSha: r.headSha,
            checks: page([]),
            statuses: { ...page([]), state: 'pending', totalCount: 0 },
          };
      }
      if (method === 'github-write-read') {
        const common = {
          ...scope,
          githubWriteVersion: 1,
          confirmed: true,
          view: r.view,
          readAt: state.readAt,
        };
        const execution = { mode: 'shared', status: 'ready', revision: 0 };
        const remote = {
          ...common,
          repository,
          configVersion: version,
          writesEnabled: true,
          bindingRevision: state.binding.revision,
        };
        if (r.view === 'overview')
          return {
            ...remote,
            execution,
            canCommit: true,
            git: {
              kind: 'git',
              branch: 'topic',
              headOid: head,
              branches: [{ name: 'topic', oid: head }],
              changes: [{ path: 'README.md', index: ' ', worktree: 'M' }],
              dirty: true,
              partial: false,
              outsideProjectChanges: false,
              version,
              issues: [],
              writeSupported: true,
            },
          };
        if (r.view === 'branches') return { ...remote, result: page(branches) };
        if (r.view === 'commit-preview')
          return {
            ...common,
            execution,
            candidateVersion: version,
            branch: 'topic',
            parentOid: head,
            indexVersion: version,
            files: r.paths.map((path: string) => ({
              path,
              kind: 'modify',
              version,
              byteLength: 3,
              mode: '100644',
              beforeText: 'old',
              afterText: 'new',
              binary: false,
              truncated: false,
            })),
          };
        if (r.view === 'push-preview')
          return {
            ...remote,
            execution,
            branch: r.branch,
            headOid: r.headOid,
            expectedRemoteOid: base,
            canPush: true,
          };
        return {
          ...remote,
          number: r.number,
          headSha: r.headSha,
          baseSha: r.baseSha,
          result: page(r.view === 'files' ? [file] : [comment]),
        };
      }
      const action = r.request ?? r,
        gitTarget = secureGitTarget(original);
      const saved = (await storage
        .forTarget(original, current)
        .read(
          method.startsWith('github-write-') ? githubWriteKey(gitTarget) : githubKey(gitTarget),
        )) as any;
      assert.deepEqual(
        saved.pending.request,
        action,
        'exact original must be persisted before dispatch',
      );
      if (state.lost) throw Error('Synthetic lost receipt');
      if (!method.startsWith('github-write-')) {
        const abandoned = method === 'github-abandon';
        const binding = abandoned
          ? { revision: action.expectedRevision }
          : {
              revision: action.expectedRevision + 1,
              ...(action.action === 'bind'
                ? {
                    context: {
                      repository: {
                        id: repository.id,
                        owner: repository.owner,
                        name: repository.name,
                      },
                      branch: action.branch,
                      subject: action.subject,
                      updatedAt: date,
                    },
                  }
                : {}),
            };
        if (!abandoned) state.binding = binding;
        return {
          ...scope,
          githubVersion: 1,
          operationId: action.operationId,
          confirmed: true,
          binding,
          ...(abandoned ? { abandoned: true } : {}),
        };
      }
      return {
        ...scope,
        githubWriteVersion: 1,
        operationId: action.operationId,
        action: action.action,
        requestVersion: state.wrong
          ? 'sha256:' + 'e'.repeat(64)
          : await githubWriteRequestVersion(action),
        phase: state.phase,
        confirmed: state.phase === 'accepted',
        ...(state.phase === 'accepted'
          ? {
              result:
                action.action === 'commit' || action.action === 'push'
                  ? { sha: head }
                  : { id: 901, number: action.number ?? 3 },
            }
          : {}),
        ...(state.released ? { released: true } : {}),
        message: 'Synthetic outcome',
        checkedAt: date,
      };
    },
  };
  const create = () => new SecureGithubController(deps);
  return {
    memory,
    storage,
    store,
    state,
    calls,
    item,
    file,
    comment,
    branches,
    deps,
    create,
    controller: create(),
  };
}
