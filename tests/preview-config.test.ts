import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PreviewConfig, type PreviewLocalTarget } from '../src/runtime/preview-config';
import type { ExecutionLease } from '../src/runtime/session-execution';
import { previewServiceSchema } from '../src/preview-protocol';

function fixture(t: { after(fn: () => unknown): void }) {
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'moor-preview-config-'))),
    rootPath = join(data, 'project'),
    worktree = join(data, 'worktree'),
    file = join(data, 'private', 'preview-v1.json');
  mkdirSync(rootPath);
  mkdirSync(worktree);
  t.after(() => rmSync(data, { recursive: true, force: true }));
  let identity = { workspaceId: 'workspace', userId: 'local:synthetic', machineId: 'machine' },
    notices = 0;
  let targets: PreviewLocalTarget[] = [
      {
        localProjectId: 'project',
        executionId: 'shared',
        label: '原目录',
        rootPath,
        projectRoot: rootPath,
      },
      {
        localProjectId: 'project',
        executionId: 'worktree',
        label: '会话工作目录',
        rootPath: worktree,
        projectRoot: rootPath,
      },
    ],
    blocked = ['http://127.0.0.1:59999'];
  const options = {
    identity: () => identity,
    targets: () => targets,
    blockedOrigins: () => blocked,
    changed() {
      notices++;
    },
  };
  let config = new PreviewConfig(file, options);
  const lease = (executionId = 'shared'): ExecutionLease => ({
    ...identity,
    workspaceId: 'workspace',
    localProjectId: 'project',
    sessionId: 'session',
    rootPath: executionId === 'shared' ? rootPath : worktree,
    projectRoot: rootPath,
    executionId,
    executionRevision: executionId === 'shared' ? 0 : 1,
  });
  return {
    data,
    rootPath,
    worktree,
    file,
    options,
    lease,
    get config() {
      return config;
    },
    get notices() {
      return notices;
    },
    set identity(value: typeof identity) {
      identity = value;
    },
    set targets(value: typeof targets) {
      targets = value;
    },
    set blocked(value: string[]) {
      blocked = value;
    },
    restart() {
      config = new PreviewConfig(file, options);
    },
    save(extra: Record<string, unknown> = {}) {
      return config.handle({
        action: 'service-save',
        expectedRevision: config.read().revision,
        localProjectId: 'project',
        executionId: 'shared',
        label: 'Synthetic front end',
        address: '127.0.0.1',
        port: 5173,
        startPath: '/',
        ...extra,
      });
    },
  };
}

test('private preview registration persists disabled by default and exposes only scoped public services after local enable', (t) => {
  const f = fixture(t);
  const state = f.save(),
    id = state.services[0]!.id;
  assert.equal(state.services[0]!.enabled, false);
  assert.equal(f.config.getServices(f.lease()).length, 0);
  assert.equal(statSync(f.file).mode & 0o777, 0o600);
  f.config.handle({ action: 'service-enabled', expectedRevision: 1, id, enabled: true });
  const binding = f.config.getService(f.lease(), id)!;
  assert.equal(binding.origin, 'http://127.0.0.1:5173');
  const publicService = f.config.getServices(f.lease())[0]!;
  assert.deepEqual(previewServiceSchema.parse(publicService), publicService);
  assert.equal(JSON.stringify(publicService).includes(f.rootPath), false);
  assert.equal(JSON.stringify(publicService).includes('5173'), false);
  assert.equal(f.config.isCurrent(binding, f.lease()), true);
  f.restart();
  assert.deepEqual(f.config.getService(f.lease(), id), binding);
  assert.equal(f.notices, 2);
});

test('worktree registration never falls back to the shared directory and scope or inode changes revoke the binding', (t) => {
  const f = fixture(t),
    id = f.save({ enabled: true }).services[0]!.id;
  const binding = f.config.getService(f.lease(), id)!;
  assert.equal(f.config.getService(f.lease('worktree'), id), undefined);
  assert.equal(f.config.getServices({ ...f.lease(), localProjectId: 'other' }).length, 0);
  for (const key of ['userId', 'workspaceId', 'machineId'] as const)
    assert.throws(() => f.config.getServices({ ...f.lease(), [key]: 'other' }), /执行范围/);
  assert.equal(f.config.isCurrent(binding, { ...f.lease(), rootPath: f.worktree }), false);
  assert.equal(
    f.config.isCurrent(binding, { ...f.lease(), sessionId: 'same-directory-fork' }),
    true,
  );
  renameSync(f.rootPath, f.rootPath + '-old');
  mkdirSync(f.rootPath);
  assert.equal(f.config.isCurrent(binding, f.lease()), false);
  assert.equal(f.config.read().services[0]!.current, false);
  assert.throws(
    () => f.config.handle({ action: 'service-enabled', expectedRevision: 1, id, enabled: true }),
    /已变化/,
  );
  f.config.handle({ action: 'service-enabled', expectedRevision: 1, id, enabled: false });
  f.config.handle({ action: 'service-remove', expectedRevision: 2, id });
  assert.equal(f.config.read().services.length, 0);
});

test('configuration revision and generation prevent stale updates and enable-disable-enable ABA', (t) => {
  const f = fixture(t),
    id = f.save({ enabled: true }).services[0]!.id;
  const original = f.config.getService(f.lease(), id)!;
  f.config.handle({ action: 'service-enabled', id, expectedRevision: 1, enabled: false });
  assert.equal(f.config.isCurrent(original, f.lease()), false);
  assert.throws(
    () => f.config.handle({ action: 'service-enabled', id, expectedRevision: 1, enabled: true }),
    /已变化/,
  );
  f.config.handle({ action: 'service-enabled', id, expectedRevision: 2, enabled: true });
  assert.equal(f.config.isCurrent(original, f.lease()), false);
  const latest = f.config.getService(f.lease(), id)!;
  assert.notEqual(latest.version, original.version);
  f.save({ id, enabled: true, port: 5174 });
  assert.equal(f.config.isCurrent(latest, f.lease()), false);
  f.identity = { workspaceId: 'workspace', userId: 'other', machineId: 'machine' };
  assert.equal(f.config.isCurrent(latest, f.lease()), false);
  assert.throws(() => f.config.read(), /主机账号/);
});

test('only explicit loopback endpoints and canonical paths are accepted and Moor ports are blocked across address families', (t) => {
  const f = fixture(t);
  for (const extra of [
    { address: 'localhost' },
    { address: '0.0.0.0' },
    { address: '169.254.169.254' },
    { port: 0 },
    { port: 65536 },
    { port: '5173' },
    { rootPath: f.worktree },
    { url: 'http://127.0.0.1:5173' },
    { startPath: '//example.test' },
    { startPath: '/%2e%2e/private' },
    { startPath: '/a/../b' },
    { startPath: '/a\\b' },
    { enabled: 'true' },
  ])
    assert.throws(() => f.save(extra), /请求无效/);
  for (const address of ['127.0.0.1', '::1'])
    assert.throws(() => f.save({ address, port: 59999 }), /Moor 自身/);
  const id = f.save({ address: '::1', enabled: true, startPath: '/app?mode=review#/details' })
    .services[0]!.id;
  const binding = f.config.getService(f.lease(), id)!;
  assert.equal(binding.origin, 'http://[::1]:5173');
  assert.equal(binding.startPath, '/app?mode=review#/details');
  f.save({ id, address: '::1', enabled: true, startPath: '/#fragment' });
  const current = f.config.getService(f.lease(), id)!;
  assert.equal(current.startPath, '/#fragment');
  assert.equal(f.config.isCurrent(current, f.lease()), true);
  f.blocked = ['http://127.0.0.1:5173'];
  assert.equal(f.config.isCurrent(current, f.lease()), false);
});

test('an endpoint cannot be reassigned to another execution until its old registration is explicitly removed', (t) => {
  const f = fixture(t),
    id = f.save().services[0]!.id;
  assert.throws(() => f.save({ executionId: 'worktree', enabled: true }), /先删除原登记/);
  assert.throws(() => f.save({ id, executionId: 'worktree' }), /删除原服务登记/);
  f.config.handle({ action: 'service-remove', expectedRevision: 1, id });
  const worktreeId = f.save({ executionId: 'worktree', enabled: true }).services[0]!.id;
  assert.equal(f.config.getServices(f.lease()).length, 0);
  assert.equal(f.config.getServices(f.lease('worktree')).length, 1);
  const original = f.config.getService(f.lease('worktree'), worktreeId)!;
  f.targets = [
    {
      localProjectId: 'project',
      executionId: 'shared',
      label: 'Shared',
      rootPath: f.rootPath,
      projectRoot: f.rootPath,
    },
  ];
  assert.equal(f.config.isCurrent(original, f.lease('worktree')), false);
  f.config.handle({ action: 'service-remove', expectedRevision: 3, id: worktreeId });
});

test('private preview configuration refuses project locations, symlink files and insecure permissions', (t) => {
  const f = fixture(t);
  const inside = new PreviewConfig(join(f.rootPath, 'preview-v1.json'), f.options);
  assert.throws(() => inside.read(), /项目目录外/);
  f.save();
  chmodSync(f.file, 0o644);
  assert.throws(() => f.config.read(), /权限/);
  chmodSync(f.file, 0o600);
  renameSync(f.file, f.file + '-original');
  symlinkSync(f.file + '-original', f.file);
  assert.throws(() => f.config.read(), /安全读取/);
  rmSync(f.file);
  renameSync(f.file + '-original', f.file);
  f.targets = [
    {
      localProjectId: 'parent',
      executionId: 'shared',
      label: 'Parent',
      rootPath: f.data,
      projectRoot: f.data,
    },
  ];
  assert.throws(() => f.config.read(), /项目目录外/);
});

test('failed persistence preserves old bindings while post-commit notification errors cannot reverse success', (t) => {
  const f = fixture(t),
    id = f.save({ enabled: true }).services[0]!.id;
  const original = readFileSync(f.file, 'utf8');
  const failing = new PreviewConfig(f.file, {
    ...f.options,
    write() {
      throw new Error('synthetic private detail');
    },
  });
  assert.throws(
    () => failing.handle({ action: 'service-remove', id, expectedRevision: 1 }),
    (error) =>
      error instanceof Error &&
      /保存失败/.test(error.message) &&
      !error.message.includes('private'),
  );
  assert.equal(readFileSync(f.file, 'utf8'), original);
  const changed = new PreviewConfig(f.file, {
    ...f.options,
    changed() {
      throw new Error('synthetic notice loss');
    },
  });
  changed.handle({ action: 'service-enabled', id, expectedRevision: 1, enabled: false });
  assert.equal(f.config.read().revision, 2);
  assert.equal(f.config.getServices(f.lease()).length, 0);
  writeFileSync(f.file, '{', { mode: 0o600 });
  assert.throws(() => f.config.read(), /安全读取/);
});

test('service and execution target limits stay bounded without dropping available entries silently', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 20; i++) f.save({ port: 5200 + i, enabled: true });
  assert.equal(f.config.getServices(f.lease()).length, 20);
  assert.throws(() => f.save({ port: 5300 }), /超过限制/);
  f.targets = Array.from({ length: 1001 }, (_, i) => ({
    localProjectId: 'project',
    executionId: 'execution-' + i,
    label: 'Synthetic',
    rootPath: f.rootPath,
    projectRoot: f.rootPath,
  }));
  assert.throws(() => f.config.read(), /超过限制/);
});
