import test from 'node:test';
import { encryptedCommandHost } from './support/encrypted-command-host';
import { mappedHost } from './support/mapped-host';
import type { HostCommand } from '../src/bridge/host-command';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStore } from '../src/runtime/store';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { Flock, LoroDoc, delta, metas, mirror, putMeta, vv } from '../src/model';
import type { Mutation } from '../src/protocol';
import type { GitPrepare, GitRemove } from '../src/git-protocol';
import { gitActionReceiptSchema, gitStateResultSchema } from '../src/git-protocol';
import {
  readProjectGit,
  prepareProjectWorktree,
  inspectProjectWorktree,
  removeProjectWorktree,
  type ProjectGitOptions,
} from '../src/runtime/project-git';
import { readProjectFileBytes } from '../src/runtime/project-files';
import { captureProjectSnapshot, enumerateProjectFiles } from '../src/runtime/project-snapshot';
import { syntheticCapabilities } from './support/agent-capabilities';

function signal<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function git(root: string, ...args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgSign=false',
      '-c',
      'user.name=Synthetic',
      '-c',
      'user.email=synthetic@example.invalid',
      '-C',
      root,
      ...args,
    ],
    {
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
        ),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}
function fixture(t: { after(fn: () => unknown): void }, subproject = false) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'moor-execution-'))),
    repository = join(temp, 'project');
  mkdirSync(repository);
  if (subproject) mkdirSync(join(repository, 'sub'));
  const root = subproject ? join(repository, 'sub') : repository;
  writeFileSync(join(root, 'file.txt'), 'before synthetic\n');
  git(repository, 'init', '--initial-branch=main');
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'Synthetic baseline');
  const file = join(temp, 'runtime.sqlite'),
    privateRoot = join(temp, 'private-worktrees');
  let store = new RuntimeStore(file, { worktreeRoot: privateRoot });
  Object.assign(store.workspace, {
    id: 'workspace',
    machineId: 'machine',
    userId: 'local:synthetic',
  });
  store.save('identity', Buffer.from(JSON.stringify(store.workspace)));
  store.machine.set(['localProject', 'project'], {
    id: 'project',
    name: 'Synthetic',
    rootPath: root,
  });
  store.machine.set(['agentConfig', 'agent'], {
    id: 'agent',
    name: 'Synthetic',
    machineId: 'machine',
    cliType: 'builtin',
    agentType: 'codex',
  });
  store.saveMachine();
  let started = signal(),
    release = signal(),
    prepares = 0,
    removes = 0;
  let checkpoint: ProjectGitOptions['checkpoint'];
  let afterRemove: (() => void) | undefined;
  let promptEffect: ((cwd: string) => void) | undefined;
  const opens: { cwd: string; native?: string }[] = [];
  const driver = {
    async open(_agent: unknown, cwd: string, native?: string) {
      opens.push({ cwd, native });
      return {
        id: 'synthetic-native',
        capabilities: syntheticCapabilities,
        async prompt() {
          promptEffect?.(cwd);
          started.resolve();
          await release.promise;
        },
        async cancel() {
          release.resolve();
        },
        close() {
          release.resolve();
        },
      };
    },
  };
  const operations = {
    readProjectGit,
    inspectProjectWorktree,
    async prepareProjectWorktree(
      repo: Parameters<typeof prepareProjectWorktree>[0],
      plan: Parameters<typeof prepareProjectWorktree>[1],
      options: ProjectGitOptions = {},
    ) {
      prepares++;
      return prepareProjectWorktree(repo, plan, { ...options, checkpoint });
    },
    async removeProjectWorktree(
      repo: Parameters<typeof removeProjectWorktree>[0],
      managed: Parameters<typeof removeProjectWorktree>[1],
      input: Parameters<typeof removeProjectWorktree>[2],
      options: ProjectGitOptions = {},
    ) {
      removes++;
      const result = await removeProjectWorktree(repo, managed, input, { ...options, checkpoint });
      afterRemove?.();
      return result;
    },
  };
  const openHost = () =>
    new HostWorkspace(
      store,
      driver,
      () => {},
      () => {},
      readProjectFileBytes,
      { capture: captureProjectSnapshot, tree: enumerateProjectFiles },
      operations,
    );
  let host = openHost();
  t.after(async () => {
    release.resolve();
    await Promise.all([...host.active.values()].map((run) => run.done));
    host.close();
    store.close();
    rmSync(temp, { recursive: true, force: true });
  });
  const scope = (sessionId = 'session') => ({
    workspaceId: 'workspace',
    localProjectId: 'project',
    sessionId,
  });
  return {
    temp,
    root,
    repository,
    file,
    privateRoot,
    opens,
    scope,
    get host() {
      return host;
    },
    get store() {
      return store;
    },
    get prepares() {
      return prepares;
    },
    get removes() {
      return removes;
    },
    set checkpoint(value: ProjectGitOptions['checkpoint']) {
      checkpoint = value;
    },
    set afterRemove(value: (() => void) | undefined) {
      afterRemove = value;
    },
    set promptEffect(value: ((cwd: string) => void) | undefined) {
      promptEffect = value;
    },
    read(sessionId = 'session') {
      return host.readGitState({ gitVersion: 1, ...scope(sessionId) }, 'project');
    },
    prepare(sessionId = 'session', newBranch = 'moor/' + sessionId): GitPrepare {
      return {
        gitVersion: 1,
        ...scope(sessionId),
        operationId: randomUUID(),
        action: 'prepare',
        expectedRevision: 0,
        baseBranch: 'main',
        expectedOid: git(repository, 'rev-parse', 'main'),
        newBranch,
      };
    },
    async start(sessionId = 'session') {
      const request = mutation(store, sessionId);
      await host.mutate(request, 'project');
      await started.promise;
      return request;
    },
    async finish() {
      release.resolve();
      await Promise.all([...host.active.values()].map((run) => run.done));
      release = signal();
      started = signal();
    },
    restart() {
      host.close();
      store.close();
      store = new RuntimeStore(file, { worktreeRoot: privateRoot });
      host = openHost();
    },
  };
}
function mutation(store: RuntimeStore, sessionId: string): Mutation {
  const doc = store.doc(sessionId),
    before = vv(doc),
    flock = Flock.fromFile(store.meta.exportFile()),
    version = flock.version(),
    old = metas(flock)['session-' + sessionId],
    turnId = randomUUID();
  const view = mirror(doc, sessionId);
  view.setState((state: any) => {
    state.history.push({
      id: turnId,
      role: 'user',
      userId: 'local:synthetic',
      timestamp: '2026-01-01T00:00:00Z',
      status: 'pending',
      finished: true,
      items: [{ type: 'text', text: 'synthetic prompt' }],
      inputConfig: {
        prompt: 'synthetic prompt',
        cliType: 'builtin',
        agentType: 'codex',
        mcpServerIds: [],
        taskToolsEnabled: false,
      },
      fileDiff: null,
    });
  });
  view.dispose();
  doc.commit();
  putMeta(
    flock,
    'session-' + sessionId,
    old
      ? { latestUserMsgId: turnId, lastMessageAt: 1 }
      : {
          id: sessionId,
          machineId: 'machine',
          userId: 'local:synthetic',
          createdAt: '2026-01-01T00:00:00Z',
          cliType: 'builtin',
          agentType: 'codex',
          agentConfigId: 'agent',
          project: { kind: 'local', localProjectId: 'project' },
          status: { type: 'idle' },
          isArchived: false,
          latestUserMsgId: turnId,
          lastMessageAt: 1,
        },
  );
  return {
    operationId: randomUUID(),
    workspaceId: 'workspace',
    sessionId,
    kind: 'turn',
    expectedTurnId: (old?.latestUserMsgId as string) ?? null,
    update: delta(doc, before),
    metaBundle: flock.exportJson(version),
  };
}
async function removal(f: ReturnType<typeof fixture>, sessionId = 'session'): Promise<GitRemove> {
  const state = await f.read(sessionId);
  return {
    gitVersion: 1,
    ...f.scope(sessionId),
    action: 'remove',
    operationId: randomUUID(),
    expectedRevision: state.execution.revision,
    executionId: state.execution.executionId!,
    expectedStateVersion: state.repository.version,
  };
}

test('new session worktree changes only execution cwd and first prompt, files, tree and frozen diff use that directory', async (t) => {
  const f = fixture(t),
    initial = gitStateResultSchema.parse(await f.read());
  assert.equal(initial.canPrepare, true);
  assert.deepEqual(initial.execution, { mode: 'shared', status: 'ready', revision: 0 });
  const action = f.prepare(),
    accepted = gitActionReceiptSchema.parse(await f.host.gitAction(action, 'project'));
  assert.equal(accepted.phase, 'accepted');
  assert.equal(accepted.execution.revision, 1);
  assert.equal(accepted.execution.status, 'ready');
  assert.equal(f.opens.length, 0);
  assert.equal(f.host.workspace.projects.length, 1);
  assert.equal(f.store.searchSource('session'), undefined);
  const execution = f.store.executions.get({
    ...f.scope(),
    userId: 'local:synthetic',
    machineId: 'machine',
  })!;
  assert.ok(execution.managed!.cwd.startsWith(f.privateRoot + '/'));
  assert.deepEqual(await f.host.gitAction(action, 'project'), accepted);
  assert.equal(f.prepares, 1);
  assert.equal((await f.read()).canPrepare, false);
  f.promptEffect = (cwd) => writeFileSync(join(cwd, 'file.txt'), 'after isolated synthetic\n');
  await f.start();
  assert.equal(f.opens[0]!.cwd, execution.managed!.cwd);
  assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'before synthetic\n');
  const file = await f.host.readProjectFile(
    { contentVersion: 1, ...f.scope(), path: 'file.txt' },
    'project',
  );
  assert.equal(file.status, 'content');
  assert.equal(
    Buffer.from((file as { data: string }).data, 'base64').toString(),
    'after isolated synthetic\n',
  );
  const tree = await f.host.readProjectTree({ contentVersion: 1, ...f.scope() }, 'project');
  assert.ok(tree.entries.some((entry) => entry.path === 'file.txt'));
  await f.finish();
  const view = mirror(f.store.doc('session'), 'session'),
    turn = structuredClone(view.getState().history.at(-1)!);
  view.dispose();
  const diff = await f.host.readTurnDiff(
    { contentVersion: 1, ...f.scope(), turnId: turn.id },
    'project',
  );
  assert.ok(diff.changes.some((change) => change.path === 'file.txt'));
  assert.equal(JSON.stringify(turn).includes(f.privateRoot), false);
  assert.throws(() => f.store.nativeSession('session'), /其他执行目录/);
  assert.equal(
    f.store.nativeSession('session', {
      executionId: accepted.execution.executionId!,
      executionRevision: 1,
    }),
    'synthetic-native',
  );
});

test('subproject worktrees preserve the repository-relative cwd and cannot read sibling files', async (t) => {
  const f = fixture(t, true),
    accepted = await f.host.gitAction(f.prepare());
  assert.equal(accepted.phase, 'accepted');
  await f.start();
  assert.ok(f.opens[0]!.cwd.endsWith('/sub'));
  await assert.rejects(
    f.host.readProjectFile({ contentVersion: 1, ...f.scope(), path: '../outside.txt' }),
  );
  await f.finish();
});

test('worktree reservation binds every host dimension before receipts and prevents another project claiming the draft', async (t) => {
  const f = fixture(t),
    action = f.prepare();
  await f.host.gitAction(action, 'project');
  f.store.machine.set(['localProject', 'other'], { id: 'other', name: 'Other', rootPath: f.root });
  f.store.saveMachine();
  f.host.updateCatalogue();
  await assert.rejects(
    f.host.readGitState({ gitVersion: 1, ...f.scope(), localProjectId: 'other' }),
  );
  await assert.rejects(f.host.gitAction({ ...action, localProjectId: 'other' }));
  await assert.rejects(f.host.gitAction({ ...action, newBranch: 'other' }));
  await assert.rejects(f.host.gitAction(action, 'other'));
  const originalOwner = f.store.workspace.userId;
  f.store.workspace.userId = 'foreign';
  await assert.rejects(f.host.gitAction(action));
  f.store.workspace.userId = originalOwner;
  assert.equal(f.prepares, 1);
});

test('existing shared sessions and native contexts cannot prepare a new execution directory', async (t) => {
  const f = fixture(t);
  await f.start();
  await f.finish();
  assert.equal(f.opens[0]!.cwd, f.root);
  assert.equal((await f.read()).canPrepare, false);
  await assert.rejects(f.host.gitAction(f.prepare()));
  f.store.setNativeSession('unrecorded-native', 'synthetic-orphan');
  await assert.rejects(f.host.gitAction(f.prepare('unrecorded-native')));
  assert.equal(f.prepares, 0);
});

test('prepare staging commits before Git and blocks prompts; a failed staged transaction performs no Git action', async (t) => {
  const f = fixture(t),
    beforeGit = signal(),
    releaseGit = signal();
  f.checkpoint = async (stage) => {
    if (stage === 'before-prepare') {
      beforeGit.resolve();
      await releaseGit.promise;
    }
  };
  const action = f.prepare(),
    preparing = f.host.gitAction(action);
  await beforeGit.promise;
  assert.equal((await f.read()).execution.status, 'creating');
  assert.equal(
    f.store.journal.db.prepare('SELECT phase FROM operation WHERE id=?').get(action.operationId)!
      .phase,
    'git-staged',
  );
  await assert.rejects(f.host.mutate(mutation(f.store, 'session'), 'project'), /Git 操作/);
  assert.equal(f.opens.length, 0);
  releaseGit.resolve();
  assert.equal((await preparing).phase, 'accepted');
  f.store.journal.db.exec(
    "CREATE TRIGGER reject_execution BEFORE INSERT ON session_execution BEGIN SELECT RAISE(ABORT,'synthetic stage failure'); END",
  );
  await assert.rejects(f.host.gitAction(f.prepare('other')));
  assert.equal(f.prepares, 1);
  assert.equal(
    f.store.journal.db
      .prepare('SELECT count(*) AS n FROM attachment_scope WHERE session_id=?')
      .get('other')!.n,
    0,
  );
});

test('dirty, active and unsaved worktrees reject cleanup before staging, while clean removal preserves branch and frozen history', async (t) => {
  const f = fixture(t);
  await f.host.gitAction(f.prepare());
  f.promptEffect = (cwd) => writeFileSync(join(cwd, 'file.txt'), 'frozen searchable synthetic\n');
  await f.start();
  await assert.rejects(f.host.gitAction(await removal(f)), /停止活动回合/);
  await f.finish();
  assert.equal((await f.read()).canRemove, false);
  await assert.rejects(f.host.gitAction(await removal(f)), /工作目录有变更/);
  assert.equal(f.removes, 0);
  const cwd = f.opens[0]!.cwd;
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', 'Synthetic isolated work');
  f.host.settlementFailures.set('session', new LoroDoc());
  await assert.rejects(f.host.gitAction(await removal(f)), /停止活动回合/);
  f.host.settlementFailures.delete('session');
  const request = await removal(f),
    receipt = await f.host.gitAction(request);
  assert.equal(receipt.execution.status, 'removed');
  assert.equal(receipt.execution.revision, 2);
  assert.equal(existsSync(cwd), false);
  assert.equal(
    git(f.repository, 'show-ref', '--verify', 'refs/heads/moor/session').split(' ')[1],
    'refs/heads/moor/session',
  );
  assert.deepEqual(await f.host.gitAction(request), receipt);
  assert.equal(f.removes, 1);
  assert.equal((await f.read()).execution.status, 'removed');
  await assert.rejects(f.host.mutate(mutation(f.store, 'session')), /已清理/);
  await assert.rejects(f.host.readProjectTree({ contentVersion: 1, ...f.scope() }), /已清理/);
  const history = await f.host.read('session');
  assert.equal(history.synced, true);
  const view = mirror(f.store.doc('session'), 'session'),
    turn = structuredClone(view.getState().history.at(-1)!);
  view.dispose();
  const diff = await f.host.readTurnDiff({ contentVersion: 1, ...f.scope(), turnId: turn.id });
  const frozen = await f.host.readDiffFile({
    contentVersion: 1,
    ...f.scope(),
    turnId: turn.id,
    path: 'file.txt',
    knownVersion: diff.reference!.version!,
  });
  assert.ok(JSON.stringify(frozen).includes('frozen searchable synthetic'));
  const search = await f.host.searchSessions({
    searchVersion: 1,
    ...f.scope(),
    query: 'searchable',
    scope: 'session',
    limit: 10,
  });
  assert.ok(search.hits.some((hit) => hit.kind === 'diff'));
  assert.equal(f.host.pendingNotifications('native').length, 1);
});

test('prepare commit failure remains unknown across restart and original retries inspect without recreating worktrees', async (t) => {
  const f = fixture(t),
    action = f.prepare();
  f.store.journal.db.exec(
    "CREATE TRIGGER fail_git_receipt BEFORE UPDATE ON operation BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END",
  );
  const result = await f.host.gitAction(action);
  assert.equal(result.phase, 'unknown');
  assert.equal(f.prepares, 1);
  const record = f.store.executions.get({
    ...f.scope(),
    userId: 'local:synthetic',
    machineId: 'machine',
  })!;
  assert.equal(existsSync(record.plan.targetPath), true);
  f.restart();
  assert.equal((await f.read()).execution.status, 'unknown');
  assert.equal(f.prepares, 1);
  await assert.rejects(f.host.mutate(mutation(f.store, 'session')), /尚未确认/);
  f.store.journal.db.exec('DROP TRIGGER fail_git_receipt');
  const recovered = await f.host.gitAction(action);
  assert.equal(recovered.phase, 'accepted');
  assert.equal(recovered.execution.status, 'ready');
  assert.equal(recovered.execution.revision, 1);
  assert.equal(f.prepares, 1);
  assert.deepEqual(await f.host.gitAction(action), recovered);
});

test('remove side-effect failure is recovered only by proving the original target and Git registration absent', async (t) => {
  const f = fixture(t);
  await f.host.gitAction(f.prepare());
  const action = await removal(f);
  f.afterRemove = () => {
    throw new Error('synthetic post-remove failure');
  };
  assert.equal((await f.host.gitAction(action)).phase, 'unknown');
  assert.equal(f.removes, 1);
  f.restart();
  assert.equal((await f.read()).execution.status, 'unknown');
  const recovered = await f.host.gitAction(action);
  assert.equal(recovered.phase, 'accepted');
  assert.equal(recovered.execution.status, 'removed');
  assert.equal(f.removes, 1);
  assert.equal(f.opens.length, 0);
});

test('branch conflicts produce a durable rejected receipt and leave the new session free to choose a different branch', async (t) => {
  const f = fixture(t),
    action = f.prepare('session', 'existing');
  git(f.repository, 'branch', 'existing');
  const result = await f.host.gitAction(action);
  assert.equal(result.phase, 'rejected');
  assert.deepEqual(result.execution, { mode: 'shared', status: 'ready', revision: 0 });
  assert.equal((await f.read()).canPrepare, true);
  assert.equal(
    git(f.repository, 'worktree', 'list', '--porcelain').split('worktree ').length - 1,
    1,
  );
  assert.equal(f.opens.length, 0);
  f.restart();
  assert.deepEqual(await f.host.gitAction(action), result);
  assert.equal(f.prepares, 1);
  const accepted = await f.host.gitAction(f.prepare());
  assert.equal(accepted.phase, 'accepted');
  assert.equal(accepted.execution.revision, 1);
  assert.equal(f.prepares, 2);
  // The original rejection is stable even after another operation succeeded.
  assert.deepEqual(await f.host.gitAction(action), result);
});

test('a new file created during removal preflight rejects the original operation without losing the ready execution binding', async (t) => {
  const f = fixture(t),
    prepared = await f.host.gitAction(f.prepare()),
    scope = { ...f.scope(), userId: 'local:synthetic', machineId: 'machine' },
    cwd = f.store.executions.get(scope)!.managed!.cwd,
    action = await removal(f);
  f.checkpoint = (stage) => {
    if (stage === 'before-remove') writeFileSync(join(cwd, 'late.txt'), 'synthetic late edit');
  };
  const rejected = await f.host.gitAction(action);
  assert.equal(rejected.phase, 'rejected');
  assert.deepEqual(rejected.execution, prepared.execution);
  assert.equal(readFileSync(join(cwd, 'late.txt'), 'utf8'), 'synthetic late edit');
  f.restart();
  assert.equal((await f.read()).execution.status, 'ready');
  assert.equal((await f.read()).canRemove, false);
  assert.deepEqual(await f.host.gitAction(action), rejected);
  assert.equal(f.removes, 1);
  f.checkpoint = undefined;
  rmSync(join(cwd, 'late.txt'));
  const removed = await f.host.gitAction(await removal(f));
  assert.equal(removed.phase, 'accepted');
  assert.equal(removed.execution.revision, 2);
  assert.equal(removed.execution.executionId, prepared.execution.executionId);
  assert.deepEqual(await f.host.gitAction(action), rejected);
});

test('missing or replaced managed directories and foreign native contexts reject the first turn before confirmation', async (t) => {
  const f = fixture(t);
  await f.host.gitAction(f.prepare());
  const scope = { ...f.scope(), userId: 'local:synthetic', machineId: 'machine' },
    record = f.store.executions.get(scope)!,
    cwd = record.managed!.cwd,
    moved = cwd + '-moved';
  renameSync(cwd, moved);
  let request = mutation(f.store, 'session');
  await assert.rejects(f.host.mutate(request), /归属已变化/);
  assert.equal(f.store.journal.has(request.operationId), false);
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'file.txt'), 'substituted content');
  request = mutation(f.store, 'session');
  await assert.rejects(f.host.mutate(request), /归属已变化/);
  assert.equal(f.store.journal.has(request.operationId), false);
  rmSync(cwd, { recursive: true });
  renameSync(moved, cwd);
  f.store.setNativeSession('session', 'foreign-shared-context');
  request = mutation(f.store, 'session');
  await assert.rejects(f.host.mutate(request), /其他执行目录/);
  assert.equal(f.store.journal.has(request.operationId), false);
  assert.equal(f.store.searchSource('session'), undefined);
  assert.equal(f.opens.length, 0);
  assert.equal(readFileSync(join(f.root, 'file.txt'), 'utf8'), 'before synthetic\n');
});

test('saved pending turns and unfinished metadata block cleanup even without an active Agent', async (t) => {
  const f = fixture(t);
  await f.host.gitAction(f.prepare());
  await f.start();
  await f.finish();
  const doc = f.store.doc('session'),
    view = mirror(doc, 'session');
  view.setState((state: any) => {
    state.history.push({
      ...state.history.find((turn: any) => turn.role === 'user'),
      id: 'pending-turn',
      read: false,
      status: 'pending',
    });
  });
  view.dispose();
  f.store.persist('session', doc);
  assert.equal(f.host.active.size, 0);
  assert.equal((await f.read()).canRemove, false);
  await assert.rejects(f.host.gitAction(await removal(f)), /停止活动回合/);
  const clean = f.store.doc('session'),
    cleanView = mirror(clean, 'session');
  cleanView.setState((state: any) => {
    state.history.pop();
  });
  cleanView.dispose();
  f.store.persist('session', clean);
  putMeta(f.store.meta, 'session-session', { latestUserMsgId: 'pending-metadata' });
  assert.equal((await f.read()).canRemove, false);
  await assert.rejects(f.host.gitAction(await removal(f)), /停止活动回合/);
  assert.equal(f.removes, 0);
});

test('external branch changes reject both the first turn and native resume before staging until the bound branch is restored', async (t) => {
  const f = fixture(t);
  await f.host.gitAction(f.prepare());
  const scope = { ...f.scope(), userId: 'local:synthetic', machineId: 'machine' },
    cwd = f.store.executions.get(scope)!.managed!.cwd;
  git(cwd, 'switch', '-c', 'external');
  assert.equal((await f.read()).execution.status, 'unknown');
  const first = mutation(f.store, 'session');
  await assert.rejects(f.host.mutate(first), /归属已变化/);
  assert.equal(f.store.journal.has(first.operationId), false);
  assert.equal(f.store.searchSource('session'), undefined);
  assert.equal(f.opens.length, 0);
  git(cwd, 'switch', 'moor/session');
  await f.start();
  await f.finish();
  assert.equal(f.opens[0]!.native, undefined);
  git(cwd, 'switch', 'external');
  const resume = mutation(f.store, 'session');
  await assert.rejects(f.host.mutate(resume), /归属已变化/);
  assert.equal(f.store.journal.has(resume.operationId), false);
  assert.equal(f.opens.length, 1);
  git(cwd, 'switch', 'moor/session');
  await f.start();
  await f.finish();
  assert.equal(f.opens[1]!.cwd, cwd);
  assert.equal(f.opens[1]!.native, 'synthetic-native');
});

test('encrypted Git revocation before the actual subprocess dispatch leaves the branch absent and another channel can inspect the original', async (t) => {
  const f = fixture(t),
    request = f.prepare(),
    entered = signal(),
    release = signal();
  const encrypted = await encryptedCommandHost(t, () => f.host),
    first = await encrypted.connect(),
    second = await encrypted.connect();
  f.checkpoint = async (stage) => {
    if (stage === 'before-prepare') {
      entered.resolve();
      await release.promise;
    }
  };
  const command: HostCommand = {
    method: 'git-action',
    workspaceId: 'workspace',
    localProjectId: 'project',
    params: request,
  };
  const pending = first.execute(command, request.sessionId);
  await entered.promise;
  first.retire();
  release.resolve();
  await assert.rejects(pending);
  assert.throws(() =>
    git(f.repository, 'rev-parse', '--verify', 'refs/heads/' + request.newBranch),
  );
  const inspected = await second.execute(
    { ...command, method: 'git-operations', params: { action: 'inspect', request } },
    request.sessionId,
  );
  assert.equal(inspected.ok, true);
  assert.equal(inspected.result.found, true);
  assert.equal(inspected.result.receipt.phase, 'rejected');
  assert.equal(f.prepares, 1);
  assert.equal((await f.read()).execution.mode, 'shared');
});

test('encrypted Git revocation after the worktree write preserves its unknown original and another channel confirms without another mutation', async (t) => {
  const f = fixture(t),
    request = f.prepare(),
    entered = signal(),
    release = signal();
  const encrypted = await encryptedCommandHost(t, () => f.host),
    first = await encrypted.connect(),
    second = await encrypted.connect();
  f.checkpoint = async (stage) => {
    if (stage === 'after-prepare') {
      entered.resolve();
      await release.promise;
    }
  };
  const command: HostCommand = {
    method: 'git-action',
    workspaceId: 'workspace',
    localProjectId: 'project',
    params: request,
  };
  const pending = first.execute(command, request.sessionId);
  await entered.promise;
  const concurrent = await second.execute(
    { ...command, method: 'git-operations', params: { action: 'abandon', request } },
    request.sessionId,
  );
  assert.equal(concurrent.ok, false);
  first.retire();
  release.resolve();
  await assert.rejects(pending);
  assert.equal((await f.read()).execution.status, 'unknown');
  const inspected = await second.execute(
    { ...command, method: 'git-operations', params: { action: 'inspect', request } },
    request.sessionId,
  );
  assert.equal(inspected.ok, true);
  assert.equal(inspected.result.receipt.phase, 'accepted');
  assert.equal(inspected.result.receipt.execution.status, 'ready');
  assert.equal(f.prepares, 1);
});

test('never-arrived Git operations inspect and seal a Host-proven old mapping after cold restart without creating a worktree', async (t) => {
  const f = fixture(t),
    request = f.prepare(),
    mapped = mappedHost(() => f.host),
    original = mapped.target();
  const action: HostCommand = {
    method: 'git-action',
    workspaceId: 'workspace',
    localProjectId: 'project',
    params: request,
  };
  const recovery = (kind: 'inspect' | 'abandon'): HostCommand => ({
    ...action,
    method: 'git-operations',
    params: { action: kind, request },
  });
  mapped.move();
  f.restart();
  mapped.reopen();
  assert.equal(((await mapped.execute(original, recovery('inspect'))) as any).found, false);
  assert.equal(f.store.journal.has(request.operationId), false);
  const sealed = (await mapped.execute(original, recovery('abandon'))) as any;
  assert.equal(sealed.receipt.phase, 'abandoned');
  f.restart();
  mapped.reopen();
  assert.equal(
    ((await mapped.execute(original, recovery('inspect'))) as any).receipt.phase,
    'abandoned',
  );
  for (const target of [original, mapped.target()])
    await assert.rejects(mapped.execute(target, action));
  assert.equal((await f.host.gitAction(request)).phase, 'abandoned');
  assert.equal(f.prepares, 0);
});

test('only durable never-dispatched proof permits sealing an unresolved Git reservation after restart', async (t) => {
  for (const legacy of [false, true]) {
    const f = fixture(t),
      request = f.prepare();
    f.checkpoint = (stage) => {
      if (stage === 'before-prepare') throw Error('Synthetic failure before Git dispatch');
    };
    f.store.journal.db.exec(
      "CREATE TRIGGER fail_git_receipt BEFORE UPDATE ON operation BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END",
    );
    assert.equal((await f.host.gitAction(request)).phase, 'unknown');
    const scope = { ...f.scope(), userId: 'local:synthetic', machineId: 'machine' };
    const record = f.store.executions.get(scope)!;
    assert.equal(record.dispatched, false);
    assert.equal(existsSync(record.plan.targetPath), false);
    if (legacy) {
      const { dispatched: _dispatched, ...oldRecord } = record;
      f.store.executions.put(oldRecord);
    }
    f.restart();
    f.store.journal.db.exec('DROP TRIGGER fail_git_receipt');
    const result = await f.host.gitOperations({ action: 'abandon', request }, 'project');
    assert.equal(result.found, true);
    if (!result.found) throw Error('Missing original');
    assert.equal(result.receipt.phase, legacy ? 'unknown' : 'abandoned');
    assert.equal(Boolean(f.store.executions.get(scope)), legacy);
    assert.equal(f.prepares, 1, 'inspection and sealing do not call the Git writer again');
    assert.throws(() =>
      git(f.repository, 'rev-parse', '--verify', 'refs/heads/' + request.newBranch),
    );
    assert.equal((await f.host.gitAction(request)).phase, legacy ? 'unknown' : 'abandoned');
    assert.equal(f.prepares, 1);
  }
});

test('Git old-mapping recovery refuses missing Host history, directory generation changes and conflicting original claims', async (t) => {
  for (const scenario of ['missing-history', 'generation', 'new-target-claim', 'changed-body']) {
    const f = fixture(t),
      request = f.prepare(),
      mapped = mappedHost(() => f.host),
      target = mapped.target();
    const action: HostCommand = {
      method: 'git-action',
      workspaceId: 'workspace',
      localProjectId: 'project',
      params: request,
    };
    mapped.move();
    if (scenario === 'missing-history')
      f.store.journal.db.exec('DELETE FROM encrypted_product_mapping');
    if (scenario === 'generation') {
      const project = f.store.machine.get(['localProject', 'project']) as object;
      f.store.machine.set(['localProject', 'project'], { ...project, rootPath: f.privateRoot });
      f.host.updateCatalogue();
      mapped.products.synchronize();
      f.store.machine.set(['localProject', 'project'], { ...project, rootPath: f.root });
      f.host.updateCatalogue();
      mapped.products.synchronize();
    }
    if (scenario === 'new-target-claim') mapped.products.bindOperation(mapped.target(), action);
    if (scenario === 'changed-body') {
      await mapped.execute(target, {
        ...action,
        method: 'git-operations',
        params: { action: 'abandon', request },
      });
      request.newBranch += '-changed';
    }
    for (const kind of ['inspect', 'abandon'] as const)
      await assert.rejects(
        mapped.execute(target, {
          ...action,
          method: 'git-operations',
          params: { action: kind, request },
        }),
      );
    assert.equal(f.prepares, 0);
  }
});

test('a Host-confirmed empty session can prepare its first worktree through the encrypted channel and keeps the pinned Agent', async (t) => {
  const f = fixture(t),
    encrypted = await encryptedCommandHost(t, () => f.host),
    client = await encrypted.connect();
  const scope = f.scope();
  const created = await client.execute(
    {
      method: 'session-control',
      workspaceId: scope.workspaceId,
      localProjectId: scope.localProjectId,
      params: {
        ...scope,
        controlVersion: 1,
        userId: 'local:synthetic',
        machineId: 'machine',
        operationId: 'create-empty',
        action: 'create',
        agentId: 'agent',
      },
    },
    scope.sessionId,
  );
  assert.equal(created.ok, true);
  assert.equal(created.result.status, 'accepted');
  assert.equal((await f.read()).canPrepare, true);
  const request = f.prepare();
  const prepared = await client.execute(
    {
      method: 'git-action',
      workspaceId: scope.workspaceId,
      localProjectId: scope.localProjectId,
      params: request,
    },
    scope.sessionId,
  );
  assert.equal(prepared.ok, true);
  assert.equal(prepared.result.phase, 'accepted');
  assert.equal(prepared.result.execution.branch, request.newBranch);
  assert.equal(
    f.opens.length,
    0,
    'creating and preparing an empty session do not launch the Agent',
  );
  assert.equal(
    f.store.agents.binding({ ...scope, userId: 'local:synthetic', machineId: 'machine' })!.id,
    'agent',
  );
  await f.start();
  await f.finish();
  assert.equal((await f.read()).canPrepare, false);
  assert.equal(f.prepares, 1);
  assert.notEqual(f.opens[0]!.cwd, f.root);
});

test('persisted session freshness refuses archived, previously used, native Fork and mismatched Agent metadata even with empty visible history', async (t) => {
  for (const scenario of [
    'archived',
    'handled',
    'pending',
    'fork',
    'agent',
    'native',
    'rewritten',
  ]) {
    const f = fixture(t),
      scope = f.scope();
    await f.host.controlManager.control(
      {
        ...scope,
        controlVersion: 1,
        userId: 'local:synthetic',
        machineId: 'machine',
        operationId: 'create-empty',
        action: 'create',
        agentId: 'agent',
      },
      'project',
    );
    assert.equal((await f.read()).canPrepare, true);
    if (scenario === 'native') f.store.setNativeSession(scope.sessionId, 'synthetic-native');
    else if (scenario === 'rewritten')
      f.store.persist(scope.sessionId, f.store.doc(scope.sessionId));
    else
      putMeta(f.store.meta, 'session-' + scope.sessionId, {
        ...(scenario === 'archived' ? { isArchived: true } : {}),
        ...(scenario === 'handled'
          ? { latestUserMsgId: 'old-turn', lastHandledUserMsgId: 'old-turn' }
          : {}),
        ...(scenario === 'pending' ? { latestUserMsgId: 'pending-turn' } : {}),
        ...(scenario === 'fork' ? { forkOrigin: { sourceSessionId: 'source' } } : {}),
        ...(scenario === 'agent' ? { agentConfigId: 'foreign-agent' } : {}),
      });
    assert.equal((await f.read()).canPrepare, false, scenario);
    await assert.rejects(f.host.gitAction(f.prepare()), scenario);
    assert.equal(f.prepares, 0);
  }
});
