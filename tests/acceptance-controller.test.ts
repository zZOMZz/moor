import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AcceptanceController,
  type AcceptanceSnapshot,
  type PreparedScene,
} from '../src/acceptance/controller';
import { snapshotBuild } from '../src/acceptance/build-snapshot';
import type { Scene } from '../src/acceptance/scenes';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function harness(observe?: (snapshot: AcceptanceSnapshot) => void) {
  type Preparation = {
    scene: Scene;
    signal: AbortSignal;
    stage(value: string): void;
    result: ReturnType<typeof deferred<PreparedScene>>;
    resource: PreparedScene;
    disposed: ReturnType<typeof deferred<void>>;
    disposals: number;
  };
  let sequence = 0;
  const starts = new Map<string, ReturnType<typeof deferred<Preparation>>>();
  const snapshots: AcceptanceSnapshot[] = [];
  const observers = new Set<{
    predicate(snapshot: AcceptanceSnapshot): boolean;
    result: ReturnType<typeof deferred<AcceptanceSnapshot>>;
  }>();
  const started = (id: string) => {
    let gate = starts.get(id);
    if (!gate) starts.set(id, (gate = deferred<Preparation>()));
    return gate;
  };
  const controller = new AcceptanceController({
    id: () => `run-${++sequence}`,
    now: () => new Date('2026-09-11T01:02:03.000Z'),
    prepare: (scene, id, signal, stage) => {
      const preparation: Preparation = {
        scene,
        signal,
        stage,
        result: deferred<PreparedScene>(),
        disposed: deferred<void>(),
        disposals: 0,
        resource: {
          buildId: `sha256:synthetic-${id}`,
          scope: {
            accountId: `account-${id}`,
            deviceId: `device-${id}`,
            workspaceId: `workspace-${id}`,
            projectId: `project-${id}`,
            sessionId: `session-${id}`,
          },
          async dispose() {
            preparation.disposals++;
            preparation.disposed.resolve();
          },
        },
      };
      started(id).resolve(preparation);
      return preparation.result.promise;
    },
    changed(snapshot) {
      snapshots.push(snapshot);
      for (const observer of observers)
        if (observer.predicate(snapshot)) {
          observers.delete(observer);
          observer.result.resolve(snapshot);
        }
      observe?.(snapshot);
    },
  });
  const waitFor = (predicate: (snapshot: AcceptanceSnapshot) => boolean) => {
    const snapshot = controller.snapshot();
    if (predicate(snapshot)) return Promise.resolve(snapshot);
    const result = deferred<AcceptanceSnapshot>();
    observers.add({ predicate, result });
    return result.promise;
  };
  const ready = async (id: string) => {
    const preparation = await started(id).promise;
    preparation.result.resolve(preparation.resource);
    await waitFor((snapshot) => snapshot.run?.id === id && snapshot.run.status === 'ready');
    return preparation;
  };
  return { controller, snapshots, started, waitFor, ready };
}

test('acceptance becomes ready only after scene preparation, and only a user command accepts it', async () => {
  const h = harness();
  try {
    const initial = await h.controller.command({ type: 'prepare', sceneId: 'narrow-dialog' });
    assert.equal(initial.run?.status, 'preparing');
    assert.equal(initial.run?.createdAt, '2026-09-11T01:02:03.000Z');
    assert.equal(initial.run?.buildId, '');
    const preparation = await h.started('run-1').promise;
    preparation.stage('Agent 已结束，正在打开弹窗');
    assert.equal(h.controller.snapshot().run?.status, 'preparing');
    assert.equal(h.controller.snapshot().run?.decision, undefined);
    await assert.rejects(h.controller.command({ type: 'accept', runId: 'run-1' }), /尚未就绪/);
    await h.ready('run-1');
    const prepared = h.controller.snapshot().run!;
    assert.equal(prepared.buildId, preparation.resource.buildId);
    assert.deepEqual(prepared.scope, preparation.resource.scope);
    assert.equal(prepared.decision, undefined);
    const accepted = await h.controller.command({ type: 'accept', runId: 'run-1' });
    assert.equal(accepted.run?.decision, 'accepted');
    assert.equal(accepted.run?.status, 'ready');
    assert.equal(preparation.disposals, 0, 'acceptance leaves the interactive scene available');
  } finally {
    await h.controller.close();
  }
});

test('stopping a pending scene disposes its late resource without announcing readiness', async () => {
  const h = harness();
  await h.controller.command({ type: 'prepare', sceneId: 'narrow-dialog' });
  const preparation = await h.started('run-1').promise;
  await h.controller.command({ type: 'stop', runId: 'run-1' });
  assert.equal(preparation.signal.aborted, true);
  const stopped = h.controller.snapshot();
  preparation.stage('late scene progress');
  preparation.result.resolve(preparation.resource);
  await preparation.disposed.promise;
  assert.deepEqual(h.controller.snapshot(), stopped);
  await h.controller.close();
  assert.equal(h.controller.snapshot().run?.stage, '现场已关闭');
  assert.equal(preparation.disposals, 1);
  assert.equal(
    h.snapshots.some((snapshot) => snapshot.run?.status === 'ready'),
    false,
  );
});

test('superseding a pending scene ignores its progress and result without disposing the new scene', async () => {
  const h = harness();
  await h.controller.command({ type: 'prepare', sceneId: 'narrow-dialog' });
  const old = await h.started('run-1').promise;
  await h.controller.command({ type: 'prepare', sceneId: 'session-drawer' });
  const current = await h.ready('run-2');
  assert.equal(old.signal.aborted, true);
  const before = h.controller.snapshot();
  old.stage('late old scene');
  old.result.resolve(old.resource);
  await old.disposed.promise;
  assert.deepEqual(h.controller.snapshot(), before);
  assert.equal(current.disposals, 0);
  assert.equal(
    h.snapshots.some((snapshot) => snapshot.run?.id === 'run-1' && snapshot.run.status === 'ready'),
    false,
  );
  await assert.rejects(h.controller.command({ type: 'stop', runId: 'run-1' }), /现场已改变/);
  assert.equal(current.signal.aborted, false);
  await h.controller.close();
  assert.equal(old.disposals, 1);
  assert.equal(current.disposals, 1);
});

test('closing during preparation waits for and cleans the late resource exactly once', async () => {
  const h = harness();
  await h.controller.command({ type: 'prepare', sceneId: 'settings-save' });
  const preparation = await h.started('run-1').promise;
  let completed = false;
  const closing = h.controller.close().then(() => {
    completed = true;
  });
  assert.equal(preparation.signal.aborted, true);
  assert.equal(completed, false);
  const before = h.controller.snapshot();
  preparation.stage('late after close');
  preparation.result.resolve(preparation.resource);
  await closing;
  assert.equal(completed, true);
  assert.equal(preparation.disposals, 1);
  assert.deepEqual(h.controller.snapshot(), before);
  await assert.rejects(
    h.controller.command({ type: 'prepare', sceneId: 'settings-save' }),
    /窗口已关闭/,
  );
  await h.controller.close();
  assert.equal(preparation.disposals, 1);
});

test('close waits for cleanup already started by stop and retains the acceptance decision', async () => {
  const h = harness();
  await h.controller.command({ type: 'prepare', sceneId: 'settings-save' });
  const preparation = await h.started('run-1').promise;
  const disposalStarted = deferred<void>();
  const disposalReleased = deferred<void>();
  const dispose = preparation.resource.dispose;
  preparation.resource.dispose = async () => {
    disposalStarted.resolve();
    await disposalReleased.promise;
    await dispose();
  };
  await h.ready('run-1');
  await h.controller.command({ type: 'accept', runId: 'run-1' });
  const stopping = h.controller.command({ type: 'stop', runId: 'run-1' });
  await disposalStarted.promise;
  const closing = h.controller.close();
  assert.equal(h.controller.close(), closing, 'concurrent closes share the same cleanup');
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  // Drain scheduled promise continuations while cleanup remains behind its explicit gate.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  assert.equal(preparation.disposals, 0);
  const recorded = h.snapshots.at(-1)!.run!;
  assert.equal(recorded.status, 'stopped');
  assert.equal(recorded.stage, '现场已关闭');
  assert.equal(recorded.decision, 'accepted');
  assert.equal(recorded.buildId, preparation.resource.buildId);
  assert.deepEqual(recorded.scope, preparation.resource.scope);
  disposalReleased.resolve();
  await Promise.all([stopping, closing]);
  assert.equal(closed, true);
  assert.equal(preparation.disposals, 1);
});

test('close drains late preparation despite notification and other disposal failures', async () => {
  const h = harness((snapshot) => {
    if (snapshot.run?.stage === '现场已关闭') throw new Error('synthetic record failure');
  });
  await h.controller.command({ type: 'prepare', sceneId: 'narrow-dialog' });
  const late = await h.started('run-1').promise;
  await h.controller.command({ type: 'prepare', sceneId: 'settings-save' });
  const current = await h.ready('run-2');
  let disposalAttempted = false;
  current.resource.dispose = async () => {
    disposalAttempted = true;
    throw new Error('synthetic disposal failure');
  };
  let settled = false;
  const closing = h.controller.close();
  void closing.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const rejected = assert.rejects(closing, (error: unknown) => {
    assert(error instanceof AggregateError);
    assert.deepEqual(error.errors.map((failure: Error) => failure.message).sort(), [
      'synthetic disposal failure',
      'synthetic record failure',
    ]);
    return true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(disposalAttempted, true);
  assert.equal(settled, false, 'a cleanup error cannot abandon a late preparation');
  late.result.resolve(late.resource);
  await rejected;
  assert.equal(late.disposals, 1);
  assert.equal(h.controller.snapshot().run?.status, 'stopped');
});

test('stop releases its scene even if recording the stopped status fails', async () => {
  const h = harness((snapshot) => {
    if (snapshot.run?.stage === '现场已停止，可手动重新准备')
      throw new Error('synthetic stop record failure');
  });
  await h.controller.command({ type: 'prepare', sceneId: 'settings-save' });
  const preparation = await h.ready('run-1');
  await assert.rejects(
    h.controller.command({ type: 'stop', runId: 'run-1' }),
    /synthetic stop record failure/,
  );
  assert.equal(preparation.disposals, 1);
  await h.controller.close();
  assert.equal(preparation.disposals, 1);
});

test('reset creates a new scoped run and old feedback cannot change the new decision', async () => {
  const h = harness();
  try {
    await h.controller.command({ type: 'prepare', sceneId: 'settings-save' });
    const old = await h.ready('run-1');
    await h.controller.command({
      type: 'feedback',
      runId: 'run-1',
      text: '  保存后名称没有更新  ',
    });
    const feedback = h.controller.snapshot().run!;
    assert.equal(feedback.decision, 'changes_requested');
    assert.equal(feedback.feedback, '保存后名称没有更新');
    assert.deepEqual(feedback.scope, old.resource.scope);
    const reset = await h.controller.command({ type: 'reset', runId: 'run-1' });
    assert.equal(reset.run?.id, 'run-2');
    assert.equal(reset.run?.sceneId, 'settings-save');
    assert.equal(reset.run?.status, 'preparing');
    assert.equal(reset.run?.decision, undefined);
    assert.equal(reset.run?.feedback, undefined);
    assert.equal(reset.run?.scope, undefined);
    await old.disposed.promise;
    const current = await h.ready('run-2');
    for (const type of ['accept', 'reset', 'stop', 'feedback'])
      await assert.rejects(
        h.controller.command({
          type,
          runId: 'run-1',
          ...(type === 'feedback' ? { text: '旧反馈' } : {}),
        }),
        /现场已改变/,
      );
    await assert.rejects(
      h.controller.command({ type: 'feedback', runId: 'unrelated-run', text: '错会话反馈' }),
      /现场已改变/,
    );
    assert.equal(h.controller.snapshot().run?.decision, undefined);
    assert.deepEqual(h.controller.snapshot().run?.scope, current.resource.scope);
    assert.equal(current.signal.aborted, false);
    assert.equal(current.disposals, 0);
  } finally {
    await h.controller.close();
  }
});

test('unrecognized scenes, executable fields and malformed commands cannot start work', async () => {
  const h = harness();
  const malformed = [
    null,
    { type: 'prepare', sceneId: 'arbitrary-scene' },
    { type: 'prepare', sceneId: 'settings-save', script: 'process.exit()' },
    { type: 'prepare', sceneId: 'settings-save', url: 'https://synthetic.invalid' },
    { type: 'prepare', sceneId: 'settings-save', command: 'synthetic command' },
    { type: 'agent-done', runId: 'run-1' },
    { type: 'reset', runId: 'run-1', sceneId: 'session-drawer' },
    { type: 'stop', runId: '' },
    { type: 'feedback', runId: 'run-1', text: '   ' },
    { type: 'feedback', runId: 'run-1', text: 'x'.repeat(4001) },
    { type: 'feedback', runId: 'run-1', text: 'synthetic', scope: { sessionId: 'other' } },
  ];
  for (const command of malformed) await assert.rejects(h.controller.command(command), /操作无效/);
  assert.equal(h.controller.snapshot().run, undefined);
  assert.equal(h.snapshots.length, 0);
  await h.controller.close();
});

test('preparation failure remains failed until an explicit new preparation', async () => {
  const h = harness();
  await h.controller.command({ type: 'prepare', sceneId: 'settings-save' });
  const failed = await h.started('run-1').promise;
  failed.result.reject(new Error('synthetic missing scene control'));
  await h.waitFor((snapshot) => snapshot.run?.status === 'failed');
  assert.equal(h.controller.snapshot().run?.error, 'synthetic missing scene control');
  await assert.rejects(
    h.controller.command({ type: 'feedback', runId: 'run-1', text: '不能验收' }),
    /尚未就绪/,
  );
  await h.controller.command({ type: 'reset', runId: 'run-1' });
  await h.ready('run-2');
  assert.equal(h.controller.snapshot().run?.error, undefined);
  await h.controller.close();
});

test('consumer edits to a snapshot cannot forge readiness, scope, feedback or scene recipes', async () => {
  const h = harness();
  await h.controller.command({ type: 'prepare', sceneId: 'session-drawer' });
  await h.ready('run-1');
  const before = h.controller.snapshot();
  const altered = h.controller.snapshot();
  altered.run!.status = 'failed';
  altered.run!.scope!.sessionId = 'different-session';
  altered.run!.feedback = 'forged feedback';
  (altered.scenes as unknown as { width: number }[])[0].width = 1;
  assert.deepEqual(h.controller.snapshot(), before);
  await h.controller.close();
});

test('build snapshots retain copied bytes and identify current assets without Git metadata', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'moor-acceptance-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'public');
  await mkdir(join(source, 'assets'), { recursive: true });
  await writeFile(join(source, 'index.html'), '<script src="/assets/main.js"></script>');
  await writeFile(join(source, 'assets/main.js'), 'synthetic build A');
  const first = await snapshotBuild(source, join(root, 'first'));
  const identical = await snapshotBuild(source, join(root, 'identical'));
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first, identical);
  await writeFile(join(source, 'assets/main.js'), 'synthetic build B');
  const edited = await snapshotBuild(source, join(root, 'edited'));
  assert.notEqual(edited, first, 'same-length asset edits must change the build identity');
  assert.equal(await readFile(join(root, 'first/assets/main.js'), 'utf8'), 'synthetic build A');
  assert.equal(await readFile(join(root, 'edited/assets/main.js'), 'utf8'), 'synthetic build B');
  await writeFile(join(source, 'assets/uncommitted.css'), '.synthetic { color: blue; }');
  const added = await snapshotBuild(source, join(root, 'added'));
  assert.notEqual(added, edited, 'new build assets must participate even without a Git commit');
  assert.equal(
    await readFile(join(root, 'added/assets/uncommitted.css'), 'utf8'),
    '.synthetic { color: blue; }',
  );
  await assert.rejects(readFile(join(root, 'first/assets/uncommitted.css')), { code: 'ENOENT' });
});

test('build snapshots reject file and directory symlinks instead of copying outside data', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'moor-acceptance-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'public');
  const outside = join(root, 'outside');
  await mkdir(source);
  await mkdir(outside);
  await writeFile(join(source, 'index.html'), '<title>synthetic</title>');
  await writeFile(join(outside, 'operator-data'), 'synthetic operator data');
  await symlink(source, join(root, 'linked-root'));
  await assert.rejects(
    snapshotBuild(join(root, 'linked-root'), join(root, 'root-copy')),
    /符号链接/,
  );
  await symlink(join(outside, 'operator-data'), join(source, 'linked-file'));
  await assert.rejects(snapshotBuild(source, join(root, 'file-copy')), /符号链接/);
  await assert.rejects(readFile(join(root, 'file-copy/linked-file')), { code: 'ENOENT' });
  await rm(join(source, 'linked-file'));
  await symlink(outside, join(source, 'linked-directory'));
  await assert.rejects(snapshotBuild(source, join(root, 'directory-copy')), /符号链接/);
  assert.equal(await readFile(join(outside, 'operator-data'), 'utf8'), 'synthetic operator data');
});

test('build snapshots refuse existing or source-contained destinations without replacing files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'moor-acceptance-destination-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'public');
  const destination = join(root, 'existing');
  await mkdir(source);
  await mkdir(destination);
  await writeFile(join(source, 'index.html'), '<title>new synthetic</title>');
  await writeFile(join(destination, 'index.html'), 'existing operator file');
  await assert.rejects(snapshotBuild(source, destination), { code: 'EEXIST' });
  assert.equal(await readFile(join(destination, 'index.html'), 'utf8'), 'existing operator file');
  await assert.rejects(snapshotBuild(source, source), /构建目录分开/);
  await assert.rejects(snapshotBuild(source, join(source, 'nested-copy')), /构建目录分开/);
  assert.equal(await readFile(join(source, 'index.html'), 'utf8'), '<title>new synthetic</title>');
});

test('build snapshot preparation rejects a directory without the built entry page', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'moor-acceptance-missing-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'public');
  await mkdir(source);
  await writeFile(join(source, 'main.js'), 'synthetic incomplete build');
  await assert.rejects(snapshotBuild(source, join(root, 'snapshot')), /先运行 pnpm build/);
});
