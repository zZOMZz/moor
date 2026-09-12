import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
  rmSync,
  existsSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { RuntimeStore } from '../src/runtime/store';
import { Flock, metas, mirror, putMeta, vv, delta } from '../src/model';
import { AppError, type Mutation } from '../src/protocol';
import type { AgentDriver } from '../src/runtime/agent';
import type { AgentForkInput, AgentForkCapabilities } from '../src/runtime/agent-fork';
import {
  forkReceiptSchema,
  type SessionFork,
  type ForkDirectory,
  type ForkCutoff,
} from '../src/fork-protocol';
import type { GitPrepare, GitRemove } from '../src/git-protocol';
import { syntheticCapabilities } from './support/agent-capabilities';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(t: { after(fn: () => unknown): void }) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'moor-fork-'))),
    root = join(temp, 'project'),
    file = join(temp, 'runtime.sqlite');
  mkdirSync(root);
  const git = (...args: string[]) =>
    execFileSync(
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
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
          ),
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      },
    ).trim();
  writeFileSync(join(root, 'file.txt'), 'synthetic baseline\n');
  git('init', '--initial-branch=main');
  git('add', '.');
  git('commit', '-m', 'Synthetic baseline');
  let store = new RuntimeStore(file);
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
  let count = 0,
    hold = false,
    release = signal(),
    started = signal(),
    beforeOpen: ((native: string | undefined) => unknown | Promise<unknown>) | undefined,
    beforeFork: ((input: AgentForkInput) => unknown | Promise<unknown>) | undefined,
    afterNative: (() => unknown | Promise<unknown>) | undefined,
    forkCapabilities: AgentForkCapabilities = {
      sameDirectory: true,
      worktree: true,
      turnCutoff: true,
      adapter: 'codex-acp',
      adapterVersion: '1.11.0',
    };
  const opens: { cwd: string; native?: string }[] = [],
    closes: string[] = [],
    prompts: string[] = [],
    forks: AgentForkInput[] = [];
  const driver: AgentDriver = {
    async open(_config, cwd, native, callbacks) {
      opens.push({ cwd, native });
      await beforeOpen?.(native);
      const id = native ?? 'native-' + ++count;
      return {
        id,
        capabilities: syntheticCapabilities,
        forkCapabilities,
        async prompt(input, binding) {
          prompts.push(input.prompt);
          callbacks.update({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'synthetic response ' + input.prompt },
          });
          started.resolve();
          if (hold) await release.promise;
          if (binding)
            callbacks.forkAnchor?.(
              {
                version: 1,
                kind: 'completed-turn',
                adapter: 'codex-acp',
                adapterVersion: '1.11.0',
                sourceNativeId: id,
                messageId: 'message-' + binding.expectedTurnId,
              },
              binding,
            );
        },
        async cancel() {
          release.resolve();
        },
        close() {
          closes.push(id);
          release.resolve();
        },
      };
    },
    async fork(_config, input) {
      forks.push(input);
      assert.ok(
        store.journal.db
          .prepare("SELECT id FROM operation WHERE phase IN ('fork-staged','fork-unknown')")
          .get(),
        'fork journal must commit before native call',
      );
      await beforeFork?.(input);
      input.assertCurrent?.();
      const nativeId = 'fork-native-' + forks.length;
      await input.onNativeId?.(nativeId);
      await afterNative?.();
      return { nativeId };
    },
  };
  const makeHost = () =>
    new HostWorkspace(
      store,
      driver,
      () => {},
      () => {},
    );
  let host = makeHost();
  t.after(async () => {
    release.resolve();
    await Promise.all([...host.active.values()].map((run) => run.done));
    host.close();
    store.close();
    rmSync(temp, { recursive: true, force: true });
  });
  const scope = (sessionId = 'source') => ({
    workspaceId: 'workspace',
    localProjectId: 'project',
    sessionId,
  });
  return {
    root,
    git,
    opens,
    closes,
    prompts,
    forks,
    scope,
    get host() {
      return host;
    },
    get store() {
      return store;
    },
    set beforeFork(value: typeof beforeFork) {
      beforeFork = value;
    },
    set beforeOpen(value: typeof beforeOpen) {
      beforeOpen = value;
    },
    set forkCapabilities(value: AgentForkCapabilities) {
      forkCapabilities = value;
    },
    set afterNative(value: typeof afterNative) {
      afterNative = value;
    },
    set hold(value: boolean) {
      hold = value;
      if (value) {
        release = signal();
        started = signal();
      }
    },
    async prompt(id = 'source', prompt = 'synthetic') {
      const request = mutation(store, id, prompt);
      await host.mutate(request, 'project');
      const run = host.active.get(id);
      await run?.done;
      return request;
    },
    async start(id = 'source') {
      const request = mutation(store, id, 'held');
      await host.mutate(request, 'project');
      await started.promise;
      return request;
    },
    async finish() {
      hold = false;
      release.resolve();
      await Promise.all([...host.active.values()].map((run) => run.done));
      release = signal();
      started = signal();
    },
    async request(
      directory: ForkDirectory = { kind: 'same-directory' },
      cutoff: ForkCutoff = { kind: 'current' },
      sourceId = 'source',
      childSessionId = 'child',
    ): Promise<SessionFork> {
      const options = await host.readForkOptions({ forkVersion: 1, ...scope(sourceId) });
      return {
        forkVersion: 1,
        ...scope(sourceId),
        childSessionId,
        operationId: randomUUID(),
        expectedSourceVersion: options.sourceVersion,
        expectedExecutionRevision: options.execution.revision,
        cutoff,
        directory,
      };
    },
    prepare(sessionId = 'source'): GitPrepare {
      return {
        gitVersion: 1,
        ...scope(sessionId),
        operationId: randomUUID(),
        action: 'prepare',
        expectedRevision: 0,
        baseBranch: 'main',
        expectedOid: git('rev-parse', 'HEAD'),
        newBranch: 'moor/' + sessionId,
      };
    },
    async remove(sessionId: string): Promise<GitRemove> {
      const state = await host.readGitState({ gitVersion: 1, ...scope(sessionId) });
      return {
        gitVersion: 1,
        ...scope(sessionId),
        operationId: randomUUID(),
        action: 'remove',
        expectedRevision: state.execution.revision,
        executionId: state.execution.executionId!,
        expectedStateVersion: state.repository.version,
      };
    },
    restart() {
      host.close();
      store.close();
      store = new RuntimeStore(file);
      host = makeHost();
    },
  };
}
function mutation(store: RuntimeStore, sessionId: string, prompt: string): Mutation {
  const doc = store.doc(sessionId),
    before = vv(doc),
    flock = Flock.fromFile(store.meta.exportFile()),
    version = flock.version(),
    old = metas(flock)['session-' + sessionId],
    turnId = randomUUID(),
    view = mirror(doc, sessionId);
  view.setState((state: any) => {
    state.history.push({
      id: turnId,
      role: 'user',
      userId: 'local:synthetic',
      timestamp: '2026-01-01T00:00:00Z',
      status: 'pending',
      finished: true,
      items: [{ type: 'text', text: prompt }],
      inputConfig: {
        prompt,
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
function history(store: RuntimeStore, id: string) {
  const view = mirror(store.doc(id), id);
  const result = structuredClone(view.getState().history);
  view.dispose();
  return result;
}

test('native Fork confirms one independent context with frozen provenance and an empty child activity history', async (t) => {
  const f = fixture(t);
  await f.prompt();
  const original = vv(f.store.doc('source')),
    native = f.store.nativeSession('source'),
    request = await f.request(),
    result = forkReceiptSchema.parse(await f.host.forkSession(request));
  assert.equal(result.phase, 'accepted');
  assert.equal(f.forks.length, 1);
  assert.equal(vv(f.store.doc('source')), original);
  assert.equal(f.store.nativeSession('source'), native);
  assert.equal(f.store.nativeSession('child'), 'fork-native-1');
  assert.deepEqual(history(f.store, 'child'), []);
  assert.deepEqual(result.execution, { mode: 'shared', status: 'ready', revision: 0 });
  assert.deepEqual((await f.host.read('child')).meta.forkOrigin, result.origin);
  assert.equal(JSON.stringify(await f.host.read('child')).includes('fork-native-1'), false);
  await f.prompt('source', 'later source');
  assert.deepEqual(await f.host.forkSession(request), result);
  assert.equal(f.forks.length, 1);
  await f.prompt('child', 'child continuation');
  assert.deepEqual(f.opens.at(-1), { cwd: f.root, native: 'fork-native-1' });
});

test('only completed scoped native anchors authorize a selected historical cutoff', async (t) => {
  const f = fixture(t);
  await f.prompt('source', 'first');
  const first = history(f.store, 'source').at(-1)!;
  await f.prompt('source', 'second');
  const options = await f.host.readForkOptions({ forkVersion: 1, ...f.scope(), turnId: first.id });
  assert.equal(options.turns.length, 1);
  assert.equal(options.turns[0]!.available, true);
  assert.equal('turnId' in options, false);
  await assert.rejects(f.host.readForkOptions({ forkVersion: 1, ...f.scope(), turnId: 'missing' }));
  const request = await f.request({ kind: 'same-directory' }, { kind: 'turn', turnId: first.id }),
    receipt = await f.host.forkSession(request);
  assert.equal(receipt.phase, 'accepted');
  assert.equal(f.forks[0]!.anchor!.messageId, 'message-' + first.id);
  assert.deepEqual(receipt.origin!.cutoff, { kind: 'turn', turnId: first.id });
  const bad = {
    ...request,
    operationId: randomUUID(),
    childSessionId: 'missing-anchor',
    cutoff: { kind: 'turn' as const, turnId: 'missing' },
  };
  await assert.rejects(f.host.forkSession(bad));
  assert.equal(f.store.journal.has(bad.operationId), false);
  assert.equal(f.forks.length, 1);
});

test('one Fork action prepares its fixed worktree before calling native and supports explicit cleanup after a proven native rejection', async (t) => {
  const f = fixture(t);
  await f.prompt();
  const directory: ForkDirectory = {
    kind: 'worktree',
    baseBranch: 'main',
    expectedOid: f.git('rev-parse', 'HEAD'),
    newBranch: 'moor/child',
  };
  const result = await f.host.forkSession(await f.request(directory));
  assert.equal(result.phase, 'accepted');
  assert.equal(result.execution!.revision, 1);
  assert.equal(result.execution!.mode, 'worktree');
  assert.notEqual(f.forks[0]!.targetCwd, f.root);
  assert.ok(existsSync(f.forks[0]!.targetCwd));
  await f.prompt('child');
  assert.equal(f.opens.at(-1)!.cwd, f.forks[0]!.targetCwd);
  f.beforeFork = () => {
    throw new AppError(409, 'Synthetic native capability rejected', true);
  };
  const rejected = await f.host.forkSession(
    await f.request(
      { ...directory, newBranch: 'moor/rejected' },
      { kind: 'current' },
      'source',
      'rejected',
    ),
  );
  assert.equal(rejected.phase, 'rejected');
  assert.equal(rejected.execution!.status, 'ready');
  assert.equal(f.store.nativeSession('rejected'), undefined);
  assert.equal(f.store.forks.blocked('rejected'), false);
  const state = await f.host.readGitState({ gitVersion: 1, ...f.scope('rejected') });
  assert.equal(state.canRemove, true);
  assert.equal(
    (await f.host.gitAction(await f.remove('rejected'))).execution.disposition,
    'removed',
  );
});

test('managed same-directory Fork protects all references, detaches one idle binding, and only removes the last clean idle binding', async (t) => {
  const f = fixture(t);
  await f.host.gitAction(f.prepare());
  await f.prompt();
  const request = await f.request(),
    result = await f.host.forkSession(request),
    cwd = f.forks[0]!.targetCwd;
  assert.equal(result.phase, 'accepted');
  const source = await f.host.readGitState({ gitVersion: 1, ...f.scope() }),
    child = await f.host.readGitState({ gitVersion: 1, ...f.scope('child') });
  assert.equal(source.boundSessions, 2);
  assert.equal(source.canRemove, false);
  assert.equal(source.canDetach, true);
  assert.equal(child.execution.executionId, source.execution.executionId);
  await assert.rejects(f.host.gitAction(await f.remove('source')), /引用/);
  f.hold = true;
  await f.start('child');
  const detached = await f.host.gitAction({
    gitVersion: 1,
    ...f.scope(),
    action: 'detach',
    operationId: randomUUID(),
    executionId: source.execution.executionId!,
    expectedRevision: source.execution.revision,
  });
  assert.equal(detached.execution.disposition, 'detached');
  assert.equal(existsSync(cwd), true);
  assert.equal((await f.host.read('source')).synced, true);
  await assert.rejects(f.host.gitAction(await f.remove('child')), /活动/);
  await f.finish();
  const removed = await f.host.gitAction(await f.remove('child'));
  assert.equal(removed.execution.disposition, 'removed');
  assert.equal(existsSync(cwd), false);
  assert.equal((await f.host.read('child')).synced, true);
  assert.deepEqual(await f.host.forkSession(request), result);
});

test('known native Fork ID survives restart and manual retry only loads the child, even after the source advances', async (t) => {
  const f = fixture(t);
  await f.prompt();
  f.afterNative = () => {
    throw new Error('/private/synthetic-secret native failure');
  };
  const request = await f.request(),
    result = await f.host.forkSession(request);
  assert.equal(result.phase, 'unknown');
  assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
  assert.equal(f.store.forks.record(request.operationId)!.nativeId, 'fork-native-1');
  assert.equal(f.store.nativeSession('child'), undefined);
  const prompt = mutation(f.store, 'child', 'must not execute');
  await assert.rejects(f.host.mutate(prompt), /Fork/);
  assert.equal(f.store.journal.has(prompt.operationId), false);
  await assert.rejects(f.host.gitAction(f.prepare('child')), /Fork/);
  await f.prompt('source', 'source continued after the native child was created');
  f.restart();
  const calls = f.opens.length,
    retry = await f.host.forkSession(request);
  assert.equal(retry.phase, 'accepted');
  assert.equal(f.forks.length, 1);
  assert.deepEqual(f.opens.slice(calls), [{ cwd: f.root, native: 'fork-native-1' }]);
  assert.equal(f.closes.at(-1), 'fork-native-1');
  assert.equal(f.store.nativeSession('child'), 'fork-native-1');
  assert.deepEqual(history(f.store, 'child'), []);
});

test('a dispatched Fork without a returned native ID remains unknown across restart and never repeats native', async (t) => {
  const f = fixture(t);
  await f.prompt();
  f.beforeFork = () => {
    throw new Error('Synthetic connection lost after dispatch');
  };
  const request = await f.request();
  assert.equal((await f.host.forkSession(request)).phase, 'unknown');
  assert.equal(f.store.forks.record(request.operationId)!.nativeId, undefined);
  f.restart();
  assert.equal((await f.host.forkSession(request)).phase, 'unknown');
  assert.equal(f.forks.length, 1);
  assert.equal(f.store.forks.blocked('child'), true);
  assert.equal(f.store.nativeSession('child'), undefined);
});

test('a failed acceptance transaction keeps the known native result durable and manual retry confirms locally without another fork', async (t) => {
  const f = fixture(t);
  await f.prompt();
  const request = await f.request();
  f.store.journal.db.exec(
    "CREATE TRIGGER fail_fork_receipt BEFORE UPDATE ON operation WHEN NEW.phase='fork-accepted' BEGIN SELECT RAISE(ABORT,'Synthetic receipt failure'); END",
  );
  assert.equal((await f.host.forkSession(request)).phase, 'unknown');
  assert.equal(f.store.forks.record(request.operationId)!.phase, 'returned');
  assert.equal(f.store.searchSource('child'), undefined);
  assert.equal(metas(f.store.meta)['session-child'], undefined);
  assert.equal(f.store.nativeSession('child'), undefined);
  await f.prompt('source', 'later source');
  f.restart();
  f.store.journal.db.exec('DROP TRIGGER fail_fork_receipt');
  const accepted = await f.host.forkSession(request);
  assert.equal(accepted.phase, 'accepted');
  assert.equal(accepted.origin!.sourceVersion, request.expectedSourceVersion);
  assert.equal(f.forks.length, 1);
  assert.equal(f.store.nativeSession('child'), 'fork-native-1');
});

test('fork staging rollback, busy source, changed source version, duplicate child and cross-scope requests never reach native', async (t) => {
  const f = fixture(t);
  await f.prompt();
  const request = await f.request();
  f.store.journal.db.exec(
    "CREATE TRIGGER fail_fork_stage BEFORE INSERT ON session_fork BEGIN SELECT RAISE(ABORT,'Synthetic stage failure'); END",
  );
  await assert.rejects(f.host.forkSession(request));
  assert.equal(f.store.journal.has(request.operationId), false);
  assert.equal(f.store.forks.child('child'), undefined);
  f.store.journal.db.exec('DROP TRIGGER fail_fork_stage');
  await f.prompt('source', 'changed');
  await assert.rejects(f.host.forkSession(request), /来源会话已变化/);
  const current = await f.request();
  await assert.rejects(f.host.forkSession({ ...current, localProjectId: 'other' }));
  await assert.rejects(f.host.forkSession(current, 'other'));
  f.hold = true;
  await f.start();
  await assert.rejects(f.host.forkSession(current), /空闲/);
  await f.finish();
  assert.equal(f.forks.length, 0);
  const accepted = await f.request();
  await f.host.forkSession(accepted);
  await assert.rejects(f.host.forkSession({ ...accepted, operationId: randomUUID() }), /子会话/);
  await assert.rejects(
    f.host.forkSession({ ...accepted, cutoff: { kind: 'turn', turnId: 'other' } }),
    /重复编号/,
  );
  assert.equal(f.forks.length, 1);
});

test('older sessions negotiate missing Fork capabilities without another prompt, and configuration changes invalidate the cache and anchors', async (t) => {
  const f = fixture(t);
  await f.prompt();
  const original = vv(f.store.doc('source')),
    native = f.store.nativeSession('source'),
    assistant = history(f.store, 'source').at(-1)!,
    calls = f.opens.length;
  f.store.journal.db.exec('DELETE FROM session_fork_capability');
  const options = await f.host.readForkOptions({ forkVersion: 1, ...f.scope() });
  assert.equal(options.currentAvailable, true);
  assert.deepEqual(f.opens.slice(calls), [{ cwd: f.root, native }]);
  assert.equal(f.closes.at(-1), native);
  assert.equal(f.prompts.length, 1);
  assert.equal(vv(f.store.doc('source')), original);
  f.restart();
  await f.host.readForkOptions({ forkVersion: 1, ...f.scope() });
  assert.equal(f.opens.length, calls + 1);
  const agent = f.store.machine.get(['agentConfig', 'agent']) as any;
  f.store.machine.set(['agentConfig', 'agent'], { ...agent, name: 'Changed configuration' });
  f.store.saveMachine();
  f.forkCapabilities = { sameDirectory: false, worktree: false, turnCutoff: false };
  const changed = await f.host.readForkOptions({
    forkVersion: 1,
    ...f.scope(),
    turnId: assistant.id,
  });
  assert.equal(f.opens.length, calls + 2);
  assert.equal(changed.currentAvailable, false);
  assert.equal(changed.turns[0]!.available, false);
  assert.notEqual(changed.sourceVersion, options.sourceVersion);
  assert.equal(f.prompts.length, 1);
});

test('a delayed capability probe cannot cache its result after source scope changes', async (t) => {
  const f = fixture(t);
  await f.prompt();
  f.store.journal.db.exec('DELETE FROM session_fork_capability');
  const entered = signal(),
    resume = signal();
  f.beforeOpen = async () => {
    entered.resolve();
    await resume.promise;
  };
  const pending = f.host.readForkOptions({ forkVersion: 1, ...f.scope() }),
    rejection = assert.rejects(pending, /不属于|变化|目标/);
  await entered.promise;
  f.store.workspace.userId = 'local:changed';
  resume.resolve();
  await rejection;
  assert.equal(
    f.store.journal.db.prepare('SELECT * FROM session_fork_capability').get(),
    undefined,
  );
  assert.equal(f.closes.at(-1), f.store.nativeSession('source'));
  assert.equal(f.prompts.length, 1);
});

test('a known native ID is retained through a transient result write failure and a rejected child-only recovery load', async (t) => {
  const f = fixture(t);
  await f.prompt();
  const request = await f.request(),
    save = f.store.forks.save.bind(f.store.forks);
  let failed = false;
  f.store.forks.save = (record) => {
    if (record.nativeId && !failed) {
      failed = true;
      throw new Error('Synthetic one-shot result save failure');
    }
    save(record);
  };
  assert.equal((await f.host.forkSession(request)).phase, 'unknown');
  assert.equal(f.store.forks.record(request.operationId)!.nativeId, 'fork-native-1');
  f.restart();
  f.beforeOpen = () => {
    throw new AppError(409, 'Synthetic child load rejected', true);
  };
  assert.equal((await f.host.forkSession(request)).phase, 'unknown');
  assert.equal(f.store.forks.blocked('child'), true);
  assert.equal(f.store.forks.record(request.operationId)!.nativeId, 'fork-native-1');
  f.beforeOpen = undefined;
  assert.equal((await f.host.forkSession(request)).phase, 'accepted');
  assert.equal(f.forks.length, 1);
});

test('a child mutation queued before a Fork reservation is rejected again inside the session queue', async (t) => {
  const f = fixture(t);
  await f.prompt();
  const request = await f.request(),
    gate = signal(),
    queueEntered = signal(),
    forkEntered = signal(),
    forkResume = signal();
  const blocked = f.host.serial('child', async () => {
    queueEntered.resolve();
    await gate.promise;
  });
  await queueEntered.promise;
  const childMutation = mutation(f.store, 'child', 'queued before reservation'),
    mutationResult = assert.rejects(f.host.mutate(childMutation), /Fork/);
  f.beforeFork = async () => {
    forkEntered.resolve();
    await forkResume.promise;
  };
  const pending = f.host.forkSession(request);
  await forkEntered.promise;
  assert.equal(f.store.forks.blocked('child'), true);
  gate.resolve();
  await blocked;
  await mutationResult;
  assert.equal(f.store.journal.has(childMutation.operationId), false);
  assert.equal(f.store.searchSource('child'), undefined);
  forkResume.resolve();
  assert.equal((await pending).phase, 'accepted');
  assert.equal(f.prompts.length, 1);
  assert.deepEqual(history(f.store, 'child'), []);
});

test('manual retry resumes a staged worktree plan before making its first native Fork call', async (t) => {
  const f = fixture(t);
  await f.prompt();
  const request = await f.request({
    kind: 'worktree',
    baseBranch: 'main',
    expectedOid: f.git('rev-parse', 'HEAD'),
    newBranch: 'moor/recover-worktree',
  });
  f.store.journal.db.exec(
    "CREATE TRIGGER fail_git_fork_receipt BEFORE UPDATE ON operation WHEN NEW.phase='git-accepted' BEGIN SELECT RAISE(ABORT,'Synthetic Git receipt failure'); END",
  );
  const unknown = await f.host.forkSession(request);
  assert.equal(unknown.phase, 'unknown');
  assert.equal(f.store.forks.record(request.operationId)!.phase, 'preparing');
  assert.equal(f.forks.length, 0);
  assert.equal(unknown.execution!.status, 'unknown');
  const executionId = unknown.execution!.executionId;
  f.restart();
  f.store.journal.db.exec('DROP TRIGGER fail_git_fork_receipt');
  const accepted = await f.host.forkSession(request);
  assert.equal(accepted.phase, 'accepted');
  assert.equal(accepted.execution!.executionId, executionId);
  assert.equal(f.forks.length, 1);
  assert.equal(
    f.git('branch', '--format=%(refname:short)', '--list', 'moor/recover-worktree'),
    'moor/recover-worktree',
  );
  assert.deepEqual(await f.host.forkSession(request), accepted);
  assert.equal(f.forks.length, 1);
});

test('shared-directory identity replacement invalidates a stale Fork source before staging', async (t) => {
  const f = fixture(t);
  await f.prompt();
  const request = await f.request();
  renameSync(f.root, f.root + '-original');
  mkdirSync(f.root);
  await assert.rejects(f.host.forkSession(request), /来源会话已变化/);
  assert.equal(f.store.journal.has(request.operationId), false);
  assert.equal(f.forks.length, 0);
});

test('an already-created child waits for its original directory identity and Agent configuration before confirmation', async (t) => {
  const f = fixture(t);
  await f.prompt();
  const request = await f.request();
  f.afterNative = () => {
    renameSync(f.root, f.root + '-original');
    mkdirSync(f.root);
  };
  assert.equal((await f.host.forkSession(request)).phase, 'unknown');
  assert.equal(f.store.forks.record(request.operationId)!.phase, 'returned');
  assert.equal(f.store.nativeSession('child'), undefined);
  assert.equal((await f.host.forkSession(request)).phase, 'unknown');
  rmSync(f.root, { recursive: true });
  renameSync(f.root + '-original', f.root);
  const agent = f.store.machine.get(['agentConfig', 'agent']) as any;
  f.store.machine.set(['agentConfig', 'agent'], {
    ...agent,
    name: 'Changed while Fork was pending',
  });
  assert.equal((await f.host.forkSession(request)).phase, 'unknown');
  f.store.machine.set(['agentConfig', 'agent'], agent);
  assert.equal((await f.host.forkSession(request)).phase, 'accepted');
  assert.equal(f.forks.length, 1);
});
