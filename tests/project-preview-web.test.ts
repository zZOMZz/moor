import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PreviewAnnotationStore,
  ProjectPreviewController,
  projectPreviewKey,
  previewRequestVersion,
  verifyPreviewFrame,
  previewAnnotationKey,
  type PreviewAnnotationSnapshot,
  type PreviewTarget,
} from '../src/web/project-preview';
import {
  previewFrame,
  previewPng,
  previewViewport,
  previewVersion,
} from './support/preview-fixture';
import type { PreviewAction, PreviewReceipt } from '../src/preview-protocol';

const target: PreviewTarget = {
  owner: 'owner',
  deviceId: 'device',
  userId: 'user',
  machineId: 'machine',
  workspaceId: 'workspace',
  localProjectId: 'project',
  sessionId: 'stable-new-session',
  catalogWorkspaceId: 'catalog',
  replicaId: 'replica',
};
const snapshot: PreviewAnnotationSnapshot = {
  serviceId: 'service',
  serviceLabel: 'Synthetic project',
  pagePath: '/settings',
  frameId: 'frame',
  capturedAt: '2026-09-12T00:00:00Z',
  viewport: { width: 390, height: 844 },
  element: {
    elementId: 'element',
    tagName: 'button',
    role: 'button',
    name: '保存',
    text: '<img src=x> 合成页面内容',
    bounds: { x: 20, y: 90, width: 120, height: 40 },
  },
  note: '请增加按钮上方的间距。',
};
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
function fixture() {
  const cache = new Map<string, any>();
  let counter = 0;
  const controls = {
    failWrite: false,
    readWait: undefined as Promise<void> | undefined,
    writeWait: undefined as Promise<void> | undefined,
  };
  const create = (scope = target, current = () => true) =>
    new PreviewAnnotationStore(scope, {
      current,
      changed() {},
      uuid: () => 'annotation-' + ++counter,
      now: () => snapshot.capturedAt,
      read: async (key) => {
        const value = structuredClone(cache.get(key));
        await controls.readWait;
        return value;
      },
      compareWrite: async (key, revision, value, guard) => {
        await controls.writeWait;
        if (!guard()) throw new Error('scope changed');
        if (controls.failWrite) throw new Error('storage failed');
        if ((cache.get(key)?.cacheRevision ?? 0) !== revision) return false;
        cache.set(key, structuredClone(value));
        return true;
      },
    });
  return { cache, controls, create };
}
test('preview annotations stay local and bound to the full immutable scope, including a stable new session', async () => {
  const f = fixture(),
    store = f.create();
  await store.load();
  const saved = await store.save(snapshot);
  assert.deepEqual(store.compose('已有草稿').prompt, '已有草稿');
  await store.select(saved.id, true);
  const composed = store.compose('已有草稿');
  assert.ok(composed.prompt.startsWith('已有草稿\n\n[网页标注 1]'));
  assert.match(composed.prompt, /390 × 844/);
  assert.match(composed.prompt, /\/settings/);
  assert.match(composed.prompt, /我的说明：\n请增加按钮上方的间距/);
  assert.equal(composed.submission.target.sessionId, target.sessionId);
  const moved = f.create({
    ...target,
    catalogWorkspaceId: 'new-catalog',
    replicaId: 'new-replica',
  });
  await moved.load();
  assert.equal(moved.compose('已有草稿').prompt, composed.prompt);
  for (const field of [
    'owner',
    'deviceId',
    'userId',
    'machineId',
    'workspaceId',
    'localProjectId',
    'sessionId',
  ]) {
    const other = f.create({ ...target, [field]: 'other' });
    await other.load();
    assert.equal(other.items.length, 0, field);
    assert.equal(other.compose('其他草稿').prompt, '其他草稿');
  }
});
test('host confirmation only clears the original selected versions; later selections and edits survive', async () => {
  const f = fixture(),
    store = f.create();
  await store.load();
  const first = await store.save(snapshot);
  await store.select(first.id, true);
  const original = store.compose('原发送').submission;
  const second = await store.save({ ...snapshot, note: '另一个标注' });
  await store.select(second.id, true);
  await store.confirmSent(original);
  assert.deepEqual(
    store.selected.map((item) => item.id),
    [second.id],
  );
  assert.equal(store.items.length, 2, 'confirmation preserves the saved annotation');

  const next = store.compose('下一条').submission;
  await store.select(second.id, false);
  await store.select(second.id, true);
  await store.confirmSent(next);
  assert.deepEqual(
    store.selected.map((item) => item.id),
    [second.id],
    'explicit re-selection is new intent',
  );
  const beforeEdit = store.compose('').submission;
  await store.save({ ...snapshot, note: '编辑后的说明' }, second.id);
  assert.equal(store.selected.length, 0, 'edited annotations require explicit re-selection');
  await store.select(second.id, true);
  await store.confirmSent(beforeEdit);
  assert.equal(store.selected[0].snapshot.note, '编辑后的说明');
  assert.throws(
    () => store.confirmSent({ ...original, target: { ...target, sessionId: 'other' } }),
    /不属于/,
  );
});
test('annotation CAS conflicts and storage failures preserve existing drafts, while pending saves block composition', async () => {
  const f = fixture(),
    first = f.create(),
    second = f.create();
  await first.load();
  await second.load();
  const saved = await first.save(snapshot);
  await assert.rejects(second.save({ ...snapshot, note: '另一页' }), /其他页面/);
  assert.ok(second.loadError);
  assert.equal(
    f.cache.get(previewAnnotationKey(target)).annotations[0].snapshot.note,
    snapshot.note,
  );
  const restored = f.create();
  await restored.load();
  f.controls.failWrite = true;
  await assert.rejects(restored.select(saved.id, true), /storage failed/);
  assert.equal(restored.selected.length, 0);
  f.controls.failWrite = false;
  const waiting = f.create(),
    gate = signal();
  await waiting.load();
  f.controls.writeWait = gate.promise;
  const selecting = waiting.select(saved.id, true);
  assert.throws(() => waiting.compose(''), /等待标注/);
  gate.resolve();
  await selecting;
  assert.equal(waiting.compose('').submission.selection.length, 1);
});
test('late reads and writes cannot move annotations into a replacement session', async () => {
  const f = fixture(),
    store = f.create();
  await store.load();
  await store.save(snapshot);
  const gate = signal();
  let current = true;
  f.controls.readWait = gate.promise;
  const stale = f.create(target, () => current),
    loading = stale.load();
  current = false;
  gate.resolve();
  await assert.rejects(loading, /所属会话已变化/);
  assert.equal(stale.items.length, 0);
  f.controls.readWait = undefined;
  current = true;
  const writer = f.create(target, () => current);
  await writer.load();
  const writeGate = signal();
  f.controls.writeWait = writeGate.promise;
  const writing = writer.save({ ...snapshot, note: 'late' });
  current = false;
  writeGate.resolve();
  await assert.rejects(writing, /所属会话已变化/);
  assert.equal(f.cache.get(previewAnnotationKey(target)).annotations.length, 1);
});
test('frozen annotation hashes, PNG bytes, scope and combined prompt limits are validated before use', async () => {
  const f = fixture(),
    store = f.create();
  await store.load();
  await assert.rejects(
    store.save({
      ...snapshot,
      image: {
        data: btoa('not png'),
        content: { version: 'sha256:' + 'a'.repeat(64), byteLength: 7, mediaType: 'image/png' },
      },
    }),
    /冻结版本/,
  );
  assert.equal(store.items.length, 0);
  const saved = await store.save(snapshot);
  await store.select(saved.id, true);
  assert.throws(() => store.compose('x'.repeat(100000)), /超过 100000/);
  const record = f.cache.get(previewAnnotationKey(target));
  record.annotations[0].snapshot.note = 'tampered';
  await assert.rejects(f.create().load(), /冻结内容/);
  record.target.deviceId = 'other-device';
  await assert.rejects(f.create().load(), /执行范围/);
});

function browserFixture() {
  const cache = new Map<string, any>(),
    calls: { path: string; body: any }[] = [];
  let counter = 0,
    frame = previewFrame();
  const controls = {
    phase: 'accepted' as PreviewReceipt['phase'],
    closed: false,
    wrong: false,
    failWrite: false,
    password: false,
    wait: undefined as undefined | (() => Promise<void>),
  };
  const create = (scope = target, current = () => true) =>
    new ProjectPreviewController(scope, {
      current,
      changed() {},
      online: () => true,
      uuid: () => `preview-operation-${++counter}`,
      read: async (key) => structuredClone(cache.get(key)),
      compareWrite: async (key, revision, value, guard) => {
        if (!guard()) throw new Error('scope changed');
        if (controls.failWrite) throw new Error('storage failed');
        if ((cache.get(key)?.cacheRevision ?? 0) !== revision) return false;
        cache.set(key, structuredClone(value));
        return true;
      },
      request: async (path, body) => {
        const value = body as any;
        calls.push({ path, body: structuredClone(body) });
        const base = {
          previewVersion: 1,
          workspaceId: scope.workspaceId,
          localProjectId: scope.localProjectId,
          sessionId: scope.sessionId,
        };
        if (path.endsWith('/read')) {
          if (value.view === 'options')
            return {
              ...base,
              view: 'options',
              confirmed: true,
              available: true,
              execution: { mode: 'shared', revision: 0, status: 'ready' },
              services: [
                { id: 'service', label: 'Synthetic', version: previewVersion, startPath: '/' },
              ],
            };
          const instance = {
            ...base,
            clientId: value.clientId,
            previewId: value.previewId,
            view: value.view,
            confirmed: true,
          };
          if (value.view === 'frame') return { ...instance, frame, expiresAt: 100000 };
          if (value.view === 'status') return { ...instance, status: 'open', expiresAt: 100000 };
          return {
            ...instance,
            frameId: value.frameId,
            element: {
              elementId: 'element',
              frameId: value.frameId,
              tag: 'input',
              role: 'textbox',
              name: '<script>name</script>',
              text: 'safe page text',
              rect: { x: 1, y: 2, width: 30, height: 20 },
              editable: true,
              password: controls.password,
            },
          };
        }
        const request: PreviewAction = value.request ?? value;
        if (path.endsWith('/action')) {
          assert.deepEqual(cache.get(projectPreviewKey(scope)).pending, request);
          if (controls.wait) await controls.wait();
          frame = previewFrame(
            'preview',
            `frame-${counter}`,
            request.action === 'open' || request.action === 'resize'
              ? request.viewport
              : frame.viewport,
          );
        }
        const close = path.endsWith('/close');
        return {
          ...base,
          clientId: request.clientId,
          operationId: controls.wrong ? 'wrong' : request.operationId,
          action: request.action,
          requestVersion: await previewRequestVersion(request),
          phase: close ? 'closed' : controls.phase,
          previewId: 'preview',
          closed: close || controls.closed,
          message: 'Synthetic receipt',
          checkedAt: snapshot.capturedAt,
          ...(!close && !controls.closed && controls.phase === 'accepted' ? { frame } : {}),
        };
      },
    });
  return { create, controls, cache, calls };
}
test('preview actions are durable once; reload and inspection never replay an unknown action', async () => {
  const f = browserFixture(),
    c = f.create();
  await c.load();
  assert.equal(f.calls.length, 0);
  await c.refreshOptions();
  await c.open('service', previewViewport);
  assert.equal(c.frame?.viewport.width, 390);
  assert.ok(
    !JSON.stringify([...f.cache.values()]).includes(previewPng().data),
    'live frame bytes stay out of cache',
  );
  await c.locate(10, 10);
  f.controls.phase = 'unknown';
  f.controls.closed = true;
  await c.interact({ action: 'input', text: 'manual input', replace: true });
  const original = structuredClone(c.pending);
  assert.equal(c.frame, undefined);
  assert.ok(c.openRequest, 'unknown+closed keeps the original close capability');
  const restored = f.create({ ...target, catalogWorkspaceId: 'moved', replicaId: 'new-route' }),
    before = f.calls.length;
  await restored.load();
  assert.equal(f.calls.length, before);
  assert.deepEqual(restored.pending, original);
  f.controls.wrong = true;
  await assert.rejects(restored.inspect(), /回执/);
  assert.deepEqual(restored.pending, original);
  f.controls.wrong = false;
  await restored.inspect();
  assert.equal(f.calls.filter((call) => call.path.endsWith('/action')).length, 2);
  assert.deepEqual(f.calls.at(-1)?.body, { request: original });
  await restored.close();
  assert.equal(restored.pending, undefined);
  assert.equal(restored.openRequest, undefined);
  assert.equal(restored.uncertainClosed, true);
  const reopened = f.create();
  await reopened.load();
  assert.equal(reopened.uncertainClosed, true);
  f.controls.closed = false;
  f.controls.phase = 'accepted';
  await reopened.refreshOptions();
  await reopened.open('service', previewViewport);
  assert.equal(reopened.active, true);
  assert.equal(reopened.uncertainClosed, false);
});
test('close consumes the original open while its response is still pending, and a late frame cannot revive the connection', async () => {
  const f = browserFixture(),
    c = f.create(),
    started = signal(),
    release = signal();
  await c.load();
  await c.refreshOptions();
  f.controls.wait = async () => {
    started.resolve();
    await release.promise;
  };
  const opening = c.open('service', previewViewport);
  await started.promise;
  const original = structuredClone(c.openRequest);
  await c.close();
  assert.equal(c.openRequest, undefined);
  assert.equal(c.frame, undefined);
  assert.deepEqual(f.calls.at(-1)?.body, { request: original });
  release.resolve();
  await assert.rejects(opening, /预览目标已变化/);
  assert.equal(c.active, false);
  assert.equal(c.frame, undefined);
  assert.equal(f.cache.get(projectPreviewKey(target)).receipt.phase, 'closed');
});
test('preview CAS and storage failures prevent dispatch, unsafe input and stale selections never become page actions', async () => {
  const f = browserFixture(),
    a = f.create(),
    b = f.create();
  await a.load();
  await b.load();
  await a.refreshOptions();
  await b.refreshOptions();
  f.controls.failWrite = true;
  await assert.rejects(a.open('service', previewViewport), /storage failed/);
  assert.equal(f.calls.filter((call) => call.path.endsWith('/action')).length, 0);
  f.controls.failWrite = false;
  await b.open('service', previewViewport);
  const concurrent = f.create();
  await concurrent.load();
  await concurrent.refreshOptions();
  await b.close();
  await assert.rejects(concurrent.close(), /其他页面/);
  const c = f.create();
  await c.load();
  await c.refreshOptions();
  await c.open('service', previewViewport);
  f.controls.password = true;
  await c.locate(10, 10);
  await assert.rejects(
    c.interact({ action: 'input', text: 'never delivered', replace: true }),
    /安全文字输入/,
  );
  assert.ok(!f.calls.some((call) => call.path.endsWith('/action') && call.body.action === 'input'));
  await c.capture();
  await assert.rejects(c.interact({ action: 'click' }), /定位/);
  await c.capture();
  await assert.rejects(c.interact({ action: 'navigate', path: '//outside.invalid' }));
});
test('annotations freeze only a verified current frame and PNG dimensions must match the declared viewport', async () => {
  const f = browserFixture(),
    c = f.create();
  await c.load();
  await c.refreshOptions();
  await c.open('service', previewViewport);
  await c.locate(10, 10);
  const before = f.calls.length,
    frozen = c.annotation('manual note', true);
  assert.equal(frozen.documentId, c.frame?.documentId);
  assert.equal(frozen.element.tagName, 'input');
  assert.equal(frozen.image?.content.mediaType, 'image/png');
  assert.equal(f.calls.length, before);
  await verifyPreviewFrame(c.frame);
  await assert.rejects(
    verifyPreviewFrame({ ...c.frame, viewport: { width: 768, height: 1024 } }),
    /版本不匹配/,
  );
  const store = fixture().create();
  await store.load();
  await store.save(frozen);
  await assert.rejects(
    store.save({ ...frozen, viewport: { width: 768, height: 1024 } }),
    /冻结版本/,
  );
  await c.capture();
  assert.throws(() => c.annotation('stale selection', false), /当前画面/);
});
