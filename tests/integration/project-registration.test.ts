import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire as createLocalRequire } from 'node:module';
import { RuntimeStore } from '@moor/host/persistence/store';
import { registerDesktopProject } from '@moor/host/projects/registration';
const { DesktopProjectRegistration } = createLocalRequire(import.meta.url)(
  resolve('apps/desktop/src/main/project-registration.cjs'),
);

test('desktop project registration preserves canonical identity and rolls back failed persistence without changing sessions', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'moor-project-registration-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const privateRoot = join(base, 'private'),
    project = join(base, 'project');
  mkdirSync(privateRoot);
  mkdirSync(project);
  const file = join(privateRoot, 'runtime.sqlite');
  let store = new RuntimeStore(file);
  t.after(() => store.close());
  const identity = {
    workspaceId: store.workspace.id,
    userId: store.workspace.userId,
    machineId: store.workspace.machineId,
  };
  const add = (path: string, extra = {}) =>
    registerDesktopProject(store, { identity, path, ...extra }, [privateRoot]);
  for (const path of [privateRoot, base, file, join(base, 'missing')])
    assert.throws(() => add(path));
  assert.throws(() => add(project, { identity: { ...identity, machineId: 'foreign' } }));
  assert.equal(store.machine.scan({ prefix: ['localProject'] }).length, 0);
  store.journal.db.exec(
    "CREATE TRIGGER reject_project BEFORE INSERT ON runtime_state WHEN NEW.key='machine' BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END",
  );
  assert.throws(() => add(project), /synthetic write failure/);
  assert.equal(store.machine.scan({ prefix: ['localProject'] }).length, 0);
  store.journal.db.exec('DROP TRIGGER reject_project');
  const result = add(project);
  const alias = join(base, 'alias');
  symlinkSync(project, alias);
  assert.deepEqual(add(alias), result);
  assert.equal(store.machine.scan({ prefix: ['localProject'] }).length, 1);
  assert.equal(store.journal.db.prepare('SELECT COUNT(*) AS count FROM session').get()!.count, 0);
  store.close();
  store = new RuntimeStore(file);
  assert.deepEqual(add(project), result);
  assert.equal(store.machine.scan({ prefix: ['localProject'] }).length, 1);
});

test('native project registration accepts only the selected path and current host receipt; timeouts never resend', async (t) => {
  const project = mkdtempSync(join(tmpdir(), 'moor-project-native-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const sent: any[] = [],
    timers = new Set<() => void>();
  let current = true;
  const child = { connected: true, send: (value: unknown) => sent.push(value) };
  const bridge = new DesktopProjectRegistration({
    bridge: () => child,
    schedule: (fn: () => void) => {
      timers.add(fn);
      return fn;
    },
    cancel: (fn: () => void) => timers.delete(fn),
  });
  t.after(() => bridge.close());
  const identity = { workspaceId: 'workspace', userId: 'user', machineId: 'machine' };
  let pending = bridge.request(project, identity, () => current);
  const request = sent.at(-1);
  bridge.receive(child, {
    type: 'register-project-result',
    requestId: request.requestId,
    ok: true,
    state: { identity, path: project, projectId: 'foreign' },
  });
  await assert.rejects(pending, /未确认/);
  pending = bridge.request(project, identity, () => current);
  current = false;
  bridge.receive(child, {
    type: 'register-project-result',
    requestId: sent.at(-1).requestId,
    ok: true,
    state: {},
  });
  await assert.rejects(pending, /已变化/);
  current = true;
  pending = bridge.request(project, identity, () => current);
  const count = sent.length;
  for (const timer of timers) timer();
  await assert.rejects(pending, /不会自动重试/);
  assert.equal(sent.length, count);
});
