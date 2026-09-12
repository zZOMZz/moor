import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { RuntimeStore } from '../src/runtime/store';
import type { PreviewDriver } from '../src/runtime/preview-driver';
import { AppError } from '../src/protocol';
import { previewActionSchema, type PreviewAction, type PreviewOpen } from '../src/preview-protocol';
import {
  previewFrame,
  previewSignal,
  previewVersion,
  previewViewport,
} from './support/preview-fixture';

function fixture(t: { after(work: () => unknown): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'moor-preview-host-')),
    root = join(dir, 'project'),
    file = join(dir, 'host.sqlite');
  mkdirSync(root);
  let store = new RuntimeStore(file);
  store.machine.set(['localProject', 'project'], {
    id: 'project',
    name: 'Synthetic',
    rootPath: root,
  });
  store.machine.set(['localProject', 'other'], { id: 'other', name: 'Other', rootPath: root });
  store.saveMachine();
  let now = Date.parse('2026-09-12T00:00:00Z'),
    next = 0;
  const timers = new Map<number, { at: number; work(): void }>();
  const state = {
    valid: true,
    calls: [] as string[],
    closed: [] as string[],
    sequence: 0,
    before: undefined as undefined | (() => Promise<void>),
    after: undefined as undefined | (() => Promise<void>),
  };
  const service = {
    id: 'service',
    label: 'Synthetic',
    version: previewVersion,
    startPath: '/',
    origin: 'http://127.0.0.1:12345',
    localProjectId: 'project',
    executionId: 'shared',
    rootIdentity: previewVersion,
    projectRootIdentity: previewVersion,
  };
  const frame = (id: string, viewport = previewViewport) =>
    previewFrame(id, 'frame-' + ++state.sequence, viewport);
  const driver: PreviewDriver = {
    async available() {
      return { available: true };
    },
    async open(binding, check) {
      await state.before?.();
      check.assertCurrent();
      check.beforeDispatch!();
      state.calls.push('open');
      await state.after?.();
      check.assertCurrent();
      return frame(binding.previewId, binding.viewport);
    },
    async capture(id, check) {
      await state.before?.();
      check.assertCurrent();
      return frame(id);
    },
    async locate(id, frameId, point, check) {
      check.assertCurrent();
      return {
        elementId: 'element',
        frameId,
        tag: 'button',
        role: 'button',
        name: 'Synthetic',
        text: 'SYNTHETIC_PRIVATE_PREVIEW_PAGE',
        rect: { x: point.x, y: point.y, width: 20, height: 20 },
        editable: false,
        password: false,
      };
    },
    async interact(request, check) {
      await state.before?.();
      check.assertCurrent();
      check.beforeDispatch!();
      state.calls.push(request.action);
      await state.after?.();
      check.assertCurrent();
      return frame(request.previewId, 'viewport' in request ? request.viewport : previewViewport);
    },
    async close(id) {
      state.closed.push(id);
    },
    async closeAll() {},
  };
  const makeHost = () =>
    new HostWorkspace(
      store,
      {
        async open() {
          throw new Error('must not start an agent');
        },
      },
      () => {},
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        driver,
        config: {
          getServices: () => {
            const { id, label, version, startPath } = service;
            const publicService = { id, label, version, startPath };
            return state.valid ? [publicService] : [];
          },
          getService: () => (state.valid ? service : undefined),
          isCurrent: () => state.valid,
        },
        now: () => now,
        schedule: (ms, work) => {
          const id = ++next;
          timers.set(id, { at: now + ms, work });
          return () => {
            timers.delete(id);
          };
        },
      },
    );
  let host = makeHost();
  const scope = {
    previewVersion: 1 as const,
    workspaceId: store.workspace.id,
    localProjectId: 'project',
    sessionId: 'new-session',
  };
  const open = (operationId = 'open'): PreviewOpen => ({
    ...scope,
    operationId,
    clientId: 'client',
    confirmed: true,
    action: 'open',
    serviceId: 'service',
    serviceVersion: previewVersion,
    executionRevision: 0,
    viewport: previewViewport,
  });
  const action = (previewId: string, frameId: string, extra: object = {}): PreviewAction =>
    previewActionSchema.parse({
      ...scope,
      previewId,
      frameId,
      clientId: 'client',
      operationId: 'click',
      confirmed: true,
      action: 'click',
      elementId: 'element',
      ...extra,
    });
  const read = (previewId: string, view: 'frame' | 'status' = 'frame') =>
    host.readPreview({ ...scope, clientId: 'client', previewId, view });
  t.after(() => {
    host.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get host() {
      return host;
    },
    get store() {
      return store;
    },
    state,
    scope,
    open,
    action,
    read,
    timers,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(id);
          timer.work();
        }
    },
    restart() {
      host.close();
      store.close();
      store = new RuntimeStore(file);
      host = makeHost();
    },
  };
}
test('preview options do not open a browser; explicit open and reads do not persist page material', async (t) => {
  const f = fixture(t),
    meta = f.store.meta.exportJson();
  const options = await f.host.readPreview({ ...f.scope, view: 'options' });
  assert.equal(options.view, 'options');
  assert.deepEqual(f.state.calls, []);
  const opened = await f.host.previewAction(f.open());
  assert.equal(opened.phase, 'accepted');
  assert.equal(opened.frame?.viewport.width, 390);
  const read = await f.read(opened.previewId!);
  assert.equal(read.view, 'frame');
  assert.deepEqual(f.state.calls, ['open']);
  assert.deepEqual(f.store.meta.exportJson(), meta);
  const records = JSON.stringify(f.store.journal.db.prepare('SELECT * FROM operation').all());
  assert.ok(!records.includes('SYNTHETIC_PRIVATE_PREVIEW_PAGE'));
  assert.ok(!records.includes(opened.frame!.image.data));
  assert.equal(f.store.journal.db.prepare('SELECT count(*) AS n FROM session').get()!.n, 0);
});
test('original preview operation is never dispatched twice and cannot change scope or payload', async (t) => {
  const f = fixture(t),
    request = f.open(),
    opened = await f.host.previewAction(request);
  const duplicate = await f.host.previewAction(request);
  assert.equal(duplicate.phase, 'accepted');
  assert.equal(duplicate.frame, undefined);
  assert.equal((await f.host.inspectPreview({ request })).previewId, opened.previewId);
  await assert.rejects(
    f.host.previewAction({ ...request, viewport: { width: 800, height: 600 } }),
    /不同请求/,
  );
  await assert.rejects(
    f.host.previewAction({ ...request, clientId: 'another-client' }),
    /不同请求/,
  );
  await assert.rejects(f.host.previewAction({ ...request, localProjectId: 'other' }));
  await assert.rejects(
    f.host.readPreview({
      ...f.scope,
      clientId: 'other',
      previewId: opened.previewId!,
      view: 'frame',
    }),
  );
  assert.deepEqual(f.state.calls, ['open']);
});
test('lost input acknowledgement closes its renderer and inspection cannot repeat input', async (t) => {
  const f = fixture(t),
    opened = await f.host.previewAction(f.open());
  f.state.after = async () => {
    throw new Error('lost result');
  };
  const request = f.action(opened.previewId!, opened.frame!.frameId, {
    action: 'input',
    text: 'SYNTHETIC_PRIVATE_INPUT',
    replace: true,
  });
  const result = await f.host.previewAction(request);
  assert.equal(result.phase, 'unknown');
  assert.equal(result.closed, true);
  assert.equal((await f.host.previewAction(request)).phase, 'unknown');
  assert.equal((await f.host.inspectPreview({ request })).phase, 'unknown');
  assert.deepEqual(f.state.calls, ['open', 'input']);
  assert.ok(
    !JSON.stringify(f.store.journal.db.prepare('SELECT * FROM operation').all()).includes(
      'SYNTHETIC_PRIVATE_INPUT',
    ),
  );
});
test('close tombstones an undelivered open and invalidates an in-flight open before dispatch', async (t) => {
  const f = fixture(t),
    request = f.open('late');
  assert.equal((await f.host.closePreview({ request })).phase, 'closed');
  assert.equal((await f.host.previewAction(request)).phase, 'closed');
  assert.deepEqual(f.state.calls, []);
  const entered = previewSignal(),
    release = previewSignal();
  f.state.before = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = f.host.previewAction(f.open('race'));
  await entered.promise;
  assert.equal((await f.host.closePreview({ request: f.open('race') })).closed, true);
  release.resolve();
  assert.equal((await pending).phase, 'closed');
  assert.deepEqual(f.state.calls, []);
});
test('old frame interactions are rejected before dispatch while current connection remains usable', async (t) => {
  const f = fixture(t),
    opened = await f.host.previewAction(f.open());
  await f.read(opened.previewId!);
  const result = await f.host.previewAction(f.action(opened.previewId!, opened.frame!.frameId));
  assert.equal(result.phase, 'rejected');
  assert.equal(result.closed, false);
  assert.deepEqual(f.state.calls, ['open']);
  assert.equal((await f.read(opened.previewId!, 'status')).view, 'status');
});
test('configuration revoked during capture prevents late page disclosure and destroys renderer', async (t) => {
  const f = fixture(t),
    opened = await f.host.previewAction(f.open()),
    entered = previewSignal(),
    release = previewSignal();
  f.state.before = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = f.read(opened.previewId!);
  await entered.promise;
  f.state.valid = false;
  release.resolve();
  await assert.rejects(pending, /登记已变化/);
  assert.ok(f.state.closed.includes(opened.previewId!));
});
test('idle lease is renewed by explicit status and expiry closes without reconnecting', async (t) => {
  const f = fixture(t),
    opened = await f.host.previewAction(f.open());
  f.advance(29000);
  await f.read(opened.previewId!, 'status');
  f.advance(29000);
  assert.equal(f.state.closed.length, 0);
  f.advance(1000);
  assert.ok(f.state.closed.includes(opened.previewId!));
  const status = await f.read(opened.previewId!, 'status');
  assert.equal(status.view === 'status' && status.status, 'closed');
  assert.deepEqual(f.state.calls, ['open']);
});
test('operation timeout invalidates a hung dispatched action and ignores its later completion', async (t) => {
  const f = fixture(t),
    opened = await f.host.previewAction(f.open()),
    entered = previewSignal(),
    release = previewSignal();
  f.state.after = async () => {
    entered.resolve();
    await release.promise;
  };
  const request = f.action(opened.previewId!, opened.frame!.frameId),
    pending = f.host.previewAction(request);
  await entered.promise;
  f.advance(20000);
  const result = await pending;
  assert.equal(result.phase, 'unknown');
  assert.equal(result.closed, true);
  release.resolve();
  await f.host.inspectPreview({ request });
  assert.deepEqual(f.state.calls, ['open', 'click']);
});
test('restart preserves one-dispatch receipts but never restores a live preview or frame', async (t) => {
  const f = fixture(t),
    request = f.open();
  await f.host.previewAction(request);
  f.restart();
  const result = await f.host.previewAction(request);
  assert.equal(result.phase, 'accepted');
  assert.equal(result.closed, true);
  assert.equal(result.frame, undefined);
  assert.deepEqual(f.state.calls, ['open']);
});
test('preview instance limit is enforced before opening a fifth renderer', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++)
    assert.equal((await f.host.previewAction(f.open('open-' + i))).phase, 'accepted');
  assert.equal((await f.host.previewAction(f.open('fifth'))).phase, 'rejected');
  assert.equal(f.state.calls.length, 4);
});
test('a failed close journal update still tears down the renderer and never claims successful persistence', async (t) => {
  const f = fixture(t),
    request = f.open(),
    opened = await f.host.previewAction(request);
  f.store.journal.db.exec(
    "CREATE TRIGGER synthetic_failed_close BEFORE UPDATE OF phase ON operation WHEN NEW.phase='preview-closed' BEGIN SELECT RAISE(ABORT,'synthetic unavailable storage'); END",
  );
  await assert.rejects(f.host.closePreview({ request }), /synthetic unavailable storage/);
  assert.ok(f.state.closed.includes(opened.previewId!));
  assert.equal((await f.host.previewAction(request)).closed, true);
  assert.deepEqual(f.state.calls, ['open']);
});
