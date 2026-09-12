import test from 'node:test';
import strict from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { RuntimeStore } from '../src/runtime/store';
import { Flock, LoroDoc, delta, metas, mirror, putMeta, vv } from '../src/model';
import type { Mutation } from '../src/protocol';
import { readProjectFileBytes } from '../src/runtime/project-files';
import {
  captureProjectSnapshot,
  enumerateProjectFiles,
  type ProjectSnapshot,
} from '../src/runtime/project-snapshot';
import {
  projectDiffFileResultSchema,
  projectDiffReferenceSchema,
  projectTreeReadSchema,
  projectTreeResultSchema,
  projectTurnDiffResultSchema,
  type ProjectDiffReference,
} from '../src/project-content-protocol';
import { syntheticCapabilities } from './support/agent-capabilities';

const plain = {
  git: async () => {
    throw Object.assign(new Error('synthetic non-git'), { nonRepository: true });
  },
};
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
function fixture(
  t: { after(fn: () => void): void },
  options: {
    root?: string;
    file?: string;
    capture?: (root: string) => Promise<ProjectSnapshot>;
    tree?: typeof enumerateProjectFiles;
    onPrompt?: () => void;
    onClose?: () => void | Promise<void>;
    onOpen?: (store: RuntimeStore) => void;
  } = {},
) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'moor-project-content-')));
  const root = options.root ?? join(temp, 'project');
  if (!options.root) mkdirSync(root);
  const store = new RuntimeStore(options.file ?? ':memory:');
  if (!store.machine.get(['localProject', 'project-a'])) {
    Object.assign(store.workspace, {
      id: 'workspace-a',
      userId: 'local:synthetic',
      machineId: 'machine-a',
    });
    store.save('identity', Buffer.from(JSON.stringify(store.workspace)));
    store.machine.set(['localProject', 'project-a'], {
      id: 'project-a',
      name: 'Synthetic',
      rootPath: root,
    });
    store.machine.set(['agentConfig', 'agent-a'], {
      id: 'agent-a',
      name: 'Synthetic Agent',
      cliType: 'builtin',
      agentType: 'codex',
      machineId: 'machine-a',
    });
    store.saveMachine();
  }
  let opens = 0,
    prompts = 0,
    captures = 0,
    treeReads = 0,
    finishRequested = false,
    release: (() => void) | undefined,
    closed = false;
  const started = deferred();
  const host = new HostWorkspace(
    store,
    {
      async open() {
        opens++;
        options.onOpen?.(store);
        return {
          id: 'synthetic-native',
          capabilities: syntheticCapabilities,
          async prompt() {
            prompts++;
            options.onPrompt?.();
            started.resolve();
            await new Promise<void>((r) => {
              release = r;
              if (finishRequested) r();
            });
          },
          async cancel() {
            release?.();
          },
          close() {
            const closed = options.onClose?.();
            release?.();
            return closed;
          },
        };
      },
    },
    () => {},
    () => {},
    readProjectFileBytes,
    {
      capture: async (path) => {
        captures++;
        return options.capture ? options.capture(path) : captureProjectSnapshot(path, plain);
      },
      tree: async (path) => {
        treeReads++;
        return options.tree ? options.tree(path) : enumerateProjectFiles(path, plain);
      },
    },
  );
  const close = () => {
    if (closed) return;
    closed = true;
    host.close();
    store.close();
  };
  t.after(() => {
    close();
    rmSync(temp, { recursive: true, force: true });
  });
  return {
    host,
    store,
    root,
    temp,
    started: started.promise,
    opens: () => opens,
    prompts: () => prompts,
    captures: () => captures,
    treeReads: () => treeReads,
    write: (path: string, text: string | Buffer) => writeFileSync(join(root, path), text),
    close,
    finish: async () => {
      finishRequested = true;
      release?.();
      await Promise.all([...host.active.values()].map((run) => run.done));
      finishRequested = false;
    },
    crash: async () => {
      closed = true;
      host.closed = true;
      for (const run of host.active.values()) await run.session?.close();
      await Promise.all([...host.active.values()].map((run) => run.done));
      store.close();
    },
  };
}
function request(f: ReturnType<typeof fixture>, sessionId = 'session-a'): Mutation {
  const doc = new LoroDoc();
  doc.import(f.store.doc(sessionId).export({ mode: 'snapshot' }));
  const before = vv(doc),
    flock = Flock.fromFile(f.store.meta.exportFile()),
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
      ? { latestUserMsgId: turnId, lastMessageAt: 100 }
      : {
          id: sessionId,
          machineId: 'machine-a',
          userId: 'local:synthetic',
          createdAt: '2026-01-01T00:00:00Z',
          cliType: 'builtin',
          agentType: 'codex',
          agentConfigId: 'agent-a',
          project: { kind: 'local', localProjectId: 'project-a' },
          status: { type: 'idle' },
          isArchived: false,
          latestUserMsgId: turnId,
          lastMessageAt: 100,
        },
  );
  return {
    operationId: randomUUID(),
    workspaceId: 'workspace-a',
    sessionId,
    kind: 'turn',
    expectedTurnId: (old?.latestUserMsgId as string) ?? null,
    update: delta(doc, before),
    metaBundle: flock.exportJson(version),
  };
}
const scope = (sessionId = 'session-a') => ({
  contentVersion: 1 as const,
  workspaceId: 'workspace-a',
  localProjectId: 'project-a',
  sessionId,
});
function lastTurn(f: ReturnType<typeof fixture>, sessionId = 'session-a') {
  const view = mirror(f.store.doc(sessionId), sessionId),
    turn = structuredClone(view.getState().history.at(-1)!);
  view.dispose();
  return turn;
}

test('host records a before baseline before Agent open and frozen after only after Agent closure', async (t) => {
  const f = fixture(t, {
    onOpen(store) {
      strict.ok(
        store.journal.db.prepare('SELECT before_snapshot FROM project_diff').get()!.before_snapshot,
      );
    },
    onPrompt() {
      f.write('file.txt', 'Agent changed\n');
    },
    onClose() {
      f.write('file.txt', 'closed Agent final bytes\n');
    },
  });
  f.write('file.txt', 'original\n');
  const m = request(f),
    receipt = await f.host.mutate(m, 'project-a');
  strict.equal(receipt.delivered, true);
  await f.started;
  const turnId = f.host.active.get('session-a')!.turnId;
  const pending = await f.host.readTurnDiff({ ...scope(), turnId });
  strict.equal(pending.state, 'pending');
  await f.finish();
  const summary = projectTurnDiffResultSchema.parse(
    await f.host.readTurnDiff({ ...scope(), turnId }),
  );
  strict.equal(summary.state, 'partial');
  strict.equal(summary.changes.length, 1);
  strict.equal(summary.changes[0].kind, 'modified');
  strict.equal(JSON.stringify(summary).includes('closed Agent final bytes'), false);
  const file = projectDiffFileResultSchema.parse(
    await f.host.readDiffFile({
      ...scope(),
      turnId,
      path: 'file.txt',
      knownVersion: summary.reference!.version,
    }),
  );
  strict.equal(file.before!.text, 'original\n');
  strict.equal(file.after!.text, 'closed Agent final bytes\n');
  const turn = lastTurn(f);
  strict.equal(turn.finished, true);
  strict.equal(turn.status, 'handled');
  const reference = projectDiffReferenceSchema.parse(turn.fileDiff);
  strict.equal(reference.version, summary.reference!.version);
  strict.equal(JSON.stringify(turn).includes('original'), false);
  strict.equal(JSON.stringify(turn).includes('closed Agent final bytes'), false);
  strict.deepEqual(await f.host.mutate(m), receipt);
  strict.equal(f.prompts(), 1);
  strict.equal(f.captures(), 2);
});

test('tree reads bind scope and pages to a stable version, with no Agent dispatch', async (t) => {
  const f = fixture(t);
  for (const file of ['a.txt', 'b.txt', 'c.txt']) f.write(file, 'synthetic');
  await f.host.mutate(request(f));
  await f.finish();
  const initialOpens = f.opens(),
    first = projectTreeResultSchema.parse(await f.host.readProjectTree({ ...scope(), limit: 2 }));
  strict.equal(first.entries.length, 2);
  strict.equal(first.nextOffset, 2);
  strict.equal(first.partial, true);
  const next = await f.host.readProjectTree({
    ...scope(),
    offset: first.nextOffset,
    knownVersion: first.version,
    limit: 2,
  });
  strict.equal(next.entries.length, 1);
  strict.equal(next.nextOffset, undefined);
  f.write('d.txt', 'new');
  await strict.rejects(
    f.host.readProjectTree({ ...scope(), offset: 2, knownVersion: first.version }),
    /已变化/,
  );
  const calls = f.treeReads();
  for (const changed of [
    { workspaceId: 'wrong' },
    { sessionId: 'wrong' },
    { localProjectId: 'wrong' },
  ])
    await strict.rejects(f.host.readProjectTree({ ...scope(), ...changed }));
  await strict.rejects(f.host.readProjectTree(scope(), 'wrong-route-project'));
  strict.equal(f.treeReads(), calls);
  strict.equal(f.opens(), initialOpens);
});

test('tree revalidates the exact project root and owner after asynchronous enumeration', async (t) => {
  let f: ReturnType<typeof fixture>;
  f = fixture(t, {
    tree: async (root) => {
      const value = await enumerateProjectFiles(root, plain);
      f.store.workspace.userId = 'local:other';
      return value;
    },
  });
  f.write('file.txt', 'synthetic');
  await f.host.mutate(request(f));
  await f.finish();
  await strict.rejects(f.host.readProjectTree(scope()), /不属于/);
});

test('missing before or after snapshots never block the prompt and are explicitly unavailable', async (t) => {
  for (const failedCall of [1, 2]) {
    let count = 0;
    const f = fixture(t, {
      capture: async (root) => {
        if (++count === failedCall) throw new Error('synthetic capture failure');
        return captureProjectSnapshot(root, plain);
      },
    });
    f.write('file.txt', 'before');
    await f.host.mutate(request(f));
    await f.started;
    f.write('file.txt', 'after');
    await f.finish();
    const turn = lastTurn(f),
      diff = await f.host.readTurnDiff({ ...scope(), turnId: turn.id });
    strict.equal(f.prompts(), 1);
    strict.equal(turn.status, 'handled');
    strict.equal(diff.state, 'unavailable');
    strict.equal(diff.partial, true);
    strict.equal(diff.changes.length, 0);
    strict.ok(diff.issues.some((issue) => issue.reason === 'capture-failed'));
  }
});

test('cancelled turns close Agent first, preserve edits in frozen diff, and never reopen on retry', async (t) => {
  const f = fixture(t, {
    onPrompt() {
      f.write('file.txt', 'during turn');
    },
    onClose() {
      f.write('file.txt', 'final canceled bytes');
    },
  });
  f.write('file.txt', 'before');
  const m = request(f),
    receipt = await f.host.mutate(m);
  await f.started;
  const turnId = f.host.active.get('session-a')!.turnId;
  await f.host.cancel('session-a', turnId, 'project-a');
  strict.equal(lastTurn(f).status, 'canceled');
  strict.equal(f.host.active.size, 0);
  const file = await f.host.readDiffFile({ ...scope(), turnId, path: 'file.txt' });
  strict.equal(file.after!.text, 'final canceled bytes');
  strict.deepEqual(await f.host.mutate(m), receipt);
  strict.equal(f.opens(), 1);
});

test('cancel during before capture prevents Agent open and still terminates the confirmed turn', async (t) => {
  const entered = deferred(),
    release = deferred();
  let captures = 0;
  const f = fixture(t, {
    capture: async (root) => {
      if (++captures === 1) {
        entered.resolve();
        await release.promise;
      }
      return captureProjectSnapshot(root, plain);
    },
  });
  f.write('file.txt', 'before');
  await f.host.mutate(request(f));
  await entered.promise;
  const run = f.host.active.get('session-a')!,
    cancel = f.host.cancel('session-a', run.turnId);
  await Promise.resolve();
  release.resolve();
  await cancel;
  strict.equal(f.opens(), 0);
  strict.equal(lastTurn(f).status, 'canceled');
  strict.equal(f.host.active.size, 0);
  strict.equal(captures, 2);
});

test('a root replacement during baseline capture cannot redirect an already confirmed turn', async (t) => {
  let f: ReturnType<typeof fixture>;
  const entered = deferred(),
    release = deferred();
  f = fixture(t, {
    capture: async (root) => {
      entered.resolve();
      await release.promise;
      return captureProjectSnapshot(root, plain);
    },
  });
  f.write('file.txt', 'before');
  await f.host.mutate(request(f));
  await entered.promise;
  const replacement = { id: 'project-a', name: 'Changed root', rootPath: f.temp };
  f.store.machine.set(['localProject', 'project-a'], replacement);
  f.host.workspace.projects = [replacement];
  release.resolve();
  await Promise.all([...f.host.active.values()].map((run) => run.done));
  strict.equal(f.opens(), 0);
  strict.equal(lastTurn(f).status, 'failed');
  strict.equal(
    (await f.host.readTurnDiff({ ...scope(), turnId: lastTurn(f).id })).state,
    'unavailable',
  );
});

test('later turns and external edits never recalculate previously frozen file bodies', async (t) => {
  const f = fixture(t);
  f.write('file.txt', 'initial');
  await f.host.mutate(request(f));
  await f.started;
  f.write('file.txt', 'first final');
  await f.finish();
  const first = await f.host.readTurnDiff({ ...scope(), turnId: lastTurn(f).id }),
    firstId = first.turnId;
  await f.host.mutate(request(f));
  f.write('file.txt', 'later external edit');
  await f.finish();
  const calls = f.captures();
  f.write('file.txt', 'after all turns');
  strict.deepEqual(await f.host.readTurnDiff({ ...scope(), turnId: firstId }), first);
  const file = await f.host.readDiffFile({
    ...scope(),
    turnId: firstId,
    path: 'file.txt',
    knownVersion: first.reference!.version,
  });
  strict.equal(file.before!.text, 'initial');
  strict.equal(file.after!.text, 'first final');
  strict.equal(f.captures(), calls);
});

test('historical diff reads reject cross-session, stale version and unlisted paths without filesystem reads', async (t) => {
  const f = fixture(t);
  f.write('file.txt', 'before');
  await f.host.mutate(request(f));
  await f.started;
  f.write('file.txt', 'after');
  await f.finish();
  const turnId = lastTurn(f).id,
    calls = f.captures();
  await f.host.mutate(request(f, 'other-session'));
  await f.finish();
  await strict.rejects(f.host.readTurnDiff({ ...scope('other-session'), turnId }), /不属于/);
  await strict.rejects(f.host.readDiffFile({ ...scope(), turnId, path: '../outside' }));
  await strict.rejects(f.host.readDiffFile({ ...scope(), turnId, path: 'unlisted.txt' }), /不在/);
  await strict.rejects(
    f.host.readDiffFile({
      ...scope(),
      turnId,
      path: 'file.txt',
      knownVersion: 'sha256:' + '0'.repeat(64),
    }),
    /版本不匹配/,
  );
  const laterCalls = f.captures();
  f.host.workspace.projects = [];
  await strict.rejects(f.host.readTurnDiff({ ...scope(), turnId }), /已从主机移除/);
  await strict.rejects(
    f.host.readDiffFile({ ...scope(), turnId, path: 'file.txt' }),
    /已从主机移除/,
  );
  strict.equal(f.captures(), laterCalls);
  strict.equal(laterCalls, calls + 2);
});

test('old turns without captured rows return not-recorded instead of inspecting current files', async (t) => {
  const f = fixture(t);
  f.write('file.txt', 'before');
  await f.host.mutate(request(f));
  await f.finish();
  const turn = lastTurn(f);
  f.store.journal.db.prepare('DELETE FROM project_diff').run();
  const legacy = f.store.doc('session-a'),
    legacyView = mirror(legacy, 'session-a');
  legacyView.setState((state) => {
    state.history.at(-1)!.fileDiff = null;
  });
  legacyView.dispose();
  f.store.transaction(() => f.store.persist('session-a', legacy));
  const calls = f.captures(),
    diff = await f.host.readTurnDiff({ ...scope(), turnId: turn.id });
  strict.equal(diff.state, 'not-recorded');
  strict.equal(diff.partial, true);
  strict.equal(diff.reference, undefined);
  strict.equal(f.captures(), calls);
});

test('snapshot persistence failure stays independent of successful Agent completion', async (t) => {
  const f = fixture(t);
  f.write('file.txt', 'before');
  await f.host.mutate(request(f));
  await f.started;
  f.write('file.txt', 'after');
  f.store.journal.db.exec(
    "CREATE TRIGGER fail_diff_update BEFORE UPDATE ON project_diff BEGIN SELECT RAISE(ABORT,'synthetic snapshot failure'); END",
  );
  await f.finish();
  strict.equal(lastTurn(f).status, 'handled');
  strict.equal(f.host.active.size, 0);
  const diff = await f.host.readTurnDiff({ ...scope(), turnId: lastTurn(f).id });
  strict.equal(diff.state, 'unavailable');
  strict.ok(diff.issues.some((issue) => issue.reason === 'persistence-failed'));
  f.store.journal.db.exec('DROP TRIGGER fail_diff_update');
});

test('failure of both terminal writes exposes unsaved output, closes active execution and blocks new prompts', async (t) => {
  const f = fixture(t);
  f.write('file.txt', 'before');
  const m = request(f),
    receipt = await f.host.mutate(m);
  await f.started;
  f.write('file.txt', 'after');
  f.store.journal.db.exec(
    "CREATE TRIGGER fail_terminal_snapshot BEFORE INSERT ON session BEGIN SELECT RAISE(ABORT,'synthetic terminal disk failure'); END",
  );
  await f.finish();
  strict.equal(f.host.active.size, 0);
  const result = await f.host.read('session-a');
  strict.equal(result.persisted, false);
  strict.equal(result.synced, true);
  strict.match(result.persistenceError!, /尚未保存/);
  strict.deepEqual(await f.host.mutate(m), receipt);
  await strict.rejects(f.host.mutate(request(f)), /尚未保存/);
  strict.equal(f.prompts(), 1);
  f.store.journal.db.exec('DROP TRIGGER fail_terminal_snapshot');
});

test('restart marks pending baselines interrupted and never invents after snapshots from later filesystem state', async (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moor-diff-crash-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'original.sqlite'),
    copied = join(directory, 'copy.sqlite');
  const f = fixture(t, { file });
  f.write('file.txt', 'before');
  const m = request(f),
    receipt = await f.host.mutate(m);
  await f.started;
  const turnId = f.host.active.get('session-a')!.turnId;
  f.write('file.txt', 'unfinished edit');
  await f.crash();
  copyFileSync(file, copied);
  f.write('file.txt', 'unrelated after crash');
  const restored = fixture(t, { root: f.root, file: copied });
  strict.equal(restored.opens(), 0);
  strict.equal(restored.captures(), 0);
  const diff = await restored.host.readTurnDiff({ ...scope(), turnId });
  strict.equal(diff.state, 'interrupted');
  strict.equal(diff.partial, true);
  strict.equal(diff.changes.length, 0);
  const row = restored.store.journal.db
    .prepare('SELECT before_snapshot,after_snapshot FROM project_diff')
    .get()!;
  strict.ok(String(row.before_snapshot).includes('before'));
  strict.equal(row.after_snapshot, null);
  strict.deepEqual(await restored.host.mutate(m), receipt);
  strict.equal(restored.opens(), 0);
  strict.equal(restored.store.nativeSession('session-a'), 'synthetic-native');
});

test('project content protocol rejects inconsistent pages, references and change shapes', () => {
  strict.equal(projectTreeReadSchema.safeParse({ ...scope(), offset: 2 }).success, false);
  const ref: ProjectDiffReference = {
    contentVersion: 1,
    basis: 'project-snapshot',
    turnId: 'turn-a',
    diffId: 'diff-a',
    state: 'partial',
    version: 'sha256:' + 'a'.repeat(64),
    changeCount: 0,
  };
  strict.equal(projectDiffReferenceSchema.safeParse({ ...ref, version: undefined }).success, false);
  strict.equal(projectDiffReferenceSchema.safeParse({ ...ref, state: 'pending' }).success, false);
  const base = {
    ...scope(),
    confirmed: true,
    turnId: 'turn-a',
    state: 'partial',
    reference: ref,
    changes: [],
    partial: true,
    issues: [],
    attribution: 'shared-project',
  };
  strict.equal(projectTurnDiffResultSchema.safeParse({ ...base, turnId: 'wrong' }).success, false);
  strict.equal(
    projectTurnDiffResultSchema.safeParse({
      ...base,
      changes: [
        { path: 'a', kind: 'added', before: { path: 'a', state: 'binary', size: 1 }, after: null },
      ],
    }).success,
    false,
  );
  strict.equal(
    projectDiffFileResultSchema.safeParse({
      ...scope(),
      confirmed: true,
      turnId: 'turn-a',
      path: 'a',
      reference: { ...ref, changeCount: 1 },
      before: null,
      after: {
        path: 'a',
        state: 'text',
        size: 1,
        version: 'sha256:' + 'b'.repeat(64),
        mediaType: 'text/plain',
        text: '中文',
      },
      partial: true,
      issues: [],
      attribution: 'shared-project',
    }).success,
    false,
  );
});

test('failed Agent prompts still preserve files changed before the failure', async (t) => {
  const f = fixture(t, {
    onPrompt() {
      f.write('file.txt', 'partial Agent edit');
      throw new Error('synthetic Agent failed');
    },
  });
  f.write('file.txt', 'before');
  await f.host.mutate(request(f));
  await f.finish();
  const turn = lastTurn(f),
    diff = await f.host.readDiffFile({ ...scope(), turnId: turn.id, path: 'file.txt' });
  strict.equal(turn.status, 'failed');
  strict.equal(diff.before!.text, 'before');
  strict.equal(diff.after!.text, 'partial Agent edit');
});

test('shutdown freezes interrupted status and cannot add an after baseline once the store closes', async (t) => {
  const f = fixture(t);
  f.write('file.txt', 'before');
  await f.host.mutate(request(f));
  await f.started;
  const run = f.host.active.get('session-a')!;
  f.host.close();
  const turn = lastTurn(f);
  strict.equal(turn.status, 'failed');
  strict.equal(projectDiffReferenceSchema.parse(turn.fileDiff).state, 'interrupted');
  f.write('file.txt', 'later external edit');
  await run.done;
  strict.equal(
    f.store.journal.db.prepare('SELECT after_snapshot FROM project_diff').get()!.after_snapshot,
    null,
  );
});

test('scope changes while collecting the final baseline discard the result before persistence', async (t) => {
  let f: ReturnType<typeof fixture>,
    captures = 0;
  f = fixture(t, {
    capture: async (root) => {
      const snapshot = await captureProjectSnapshot(root, plain);
      if (++captures === 2) {
        const replacement = { id: 'project-a', name: 'Changed root', rootPath: f.temp };
        f.store.machine.set(['localProject', 'project-a'], replacement);
        f.host.workspace.projects = [replacement];
      }
      return snapshot;
    },
  });
  f.write('file.txt', 'before');
  await f.host.mutate(request(f));
  await f.started;
  f.write('file.txt', 'must discard after scope changed');
  await f.finish();
  const diff = await f.host.readTurnDiff({ ...scope(), turnId: lastTurn(f).id });
  strict.equal(diff.state, 'unavailable');
  strict.equal(
    f.store.journal.db.prepare('SELECT after_snapshot FROM project_diff').get()!.after_snapshot,
    null,
  );
});

test('terminal close suppresses late updates and prevents cancellation or a new turn until diff settles', async (t) => {
  const closing = deferred(),
    released = deferred();
  const f = fixture(t, {
    onClose() {
      closing.resolve();
      return released.promise;
    },
  });
  f.write('file.txt', 'before');
  await f.host.mutate(request(f));
  await f.started;
  const run = f.host.active.get('session-a')!,
    finished = f.finish();
  await closing.promise;
  strict.equal(run.stopped, true);
  strict.equal(f.host.active.get('session-a'), run);
  f.host.update('session-a', run, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'late output must be ignored' },
  });
  await strict.rejects(f.host.cancel('session-a', run.turnId), /已经结束/);
  await strict.rejects(f.host.mutate(request(f)), /正在运行/);
  released.resolve();
  await finished;
  strict.equal(lastTurn(f).status, 'handled');
  strict.equal(JSON.stringify(lastTurn(f)).includes('late output'), false);
});
