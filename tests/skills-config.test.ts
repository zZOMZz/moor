import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
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
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillsConfig } from '../src/runtime/skills-config';

function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moor-skills-config-'))),
    root = join(directory, 'skills'),
    project = join(directory, 'project'),
    data = join(directory, 'private'),
    file = join(data, 'skills-v1.json');
  for (const path of [root, project, data]) mkdirSync(path);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let identity = { workspaceId: 'workspace', machineId: 'machine', userId: 'synthetic-user' },
    projects = [project],
    privateRoots = [data],
    changes = 0;
  const options = {
    identity: () => identity,
    projectRoots: () => projects,
    privateRoots,
    changed: () => {
      changes++;
    },
  };
  let config = new SkillsConfig(file, options);
  return {
    directory,
    root,
    project,
    data,
    file,
    options,
    get identity() {
      return identity;
    },
    set identity(value) {
      identity = value;
    },
    set projects(value: string[]) {
      projects = value;
    },
    get changes() {
      return changes;
    },
    get config() {
      return config;
    },
    restart() {
      config = new SkillsConfig(file, options);
    },
    save(extra: Record<string, unknown> = {}) {
      return config.handle({
        action: 'source-save',
        expectedRevision: config.read().revision,
        label: 'Synthetic Skills',
        rootPath: root,
        ...extra,
      });
    },
  };
}

test('Skills roots persist privately, disabled by default, without reading Skill files or changing project data', (t) => {
  const f = fixture(t);
  // Even a broken Skill symlink is irrelevant to configuration: it is not opened.
  symlinkSync(join(f.directory, 'missing'), join(f.root, 'SKILL.md'));
  assert.deepEqual(f.config.read(), { revision: 0, sources: [] });
  assert.equal(existsSync(f.file), false);
  const source = f.save().sources[0]!;
  assert.equal(source.enabled, false);
  assert.equal(f.config.getSources(f.identity).length, 0);
  assert.equal(statSync(f.file).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(source).sort(), ['current', 'enabled', 'id', 'label', 'rootPath']);
  f.config.handle({ action: 'source-enabled', expectedRevision: 1, id: source.id, enabled: true });
  const binding = f.config.getSources(f.identity)[0]!;
  assert.equal(binding.rootPath, f.root);
  assert.match(binding.rootIdentity, /^sha256:[a-f0-9]{64}$/);
  assert.equal(f.config.isCurrent(binding, f.identity), true);
  f.restart();
  assert.deepEqual(f.config.getSources(f.identity), [binding]);
  assert.equal(f.changes, 2);
  for (const key of ['workspaceId', 'machineId', 'userId'] as const) {
    const scope = { ...f.identity, [key]: 'other' };
    assert.throws(() => f.config.getSources(scope), /执行范围/);
    assert.equal(f.config.isCurrent(binding, scope), false);
  }
});

test('Skills config CAS and generation prevent stale saves and enable-disable-enable or remove-recreate ABA', (t) => {
  const f = fixture(t),
    source = f.save({ enabled: true }).sources[0]!,
    original = f.config.getSources(f.identity)[0]!;
  f.config.handle({ action: 'source-enabled', expectedRevision: 1, id: source.id, enabled: false });
  assert.equal(f.config.isCurrent(original, f.identity), false);
  assert.throws(
    () =>
      f.config.handle({
        action: 'source-enabled',
        expectedRevision: 1,
        id: source.id,
        enabled: true,
      }),
    /已变化/,
  );
  f.config.handle({ action: 'source-enabled', expectedRevision: 2, id: source.id, enabled: true });
  assert.equal(f.config.isCurrent(original, f.identity), false);
  const latest = f.config.getSources(f.identity)[0]!;
  f.save({ id: source.id });
  assert.equal(f.config.read().sources[0]!.enabled, false, 'editing also requires explicit enable');
  f.config.handle({ action: 'source-remove', expectedRevision: 4, id: source.id });
  const replacement = f.save({ enabled: true }).sources[0]!;
  assert.notEqual(replacement.id, source.id);
  assert.equal(f.config.isCurrent(latest, f.identity), false);
  assert.throws(() => f.save({ id: source.id }), /不存在/);
});

test('replaced roots revoke bindings while stale registrations can still be disabled or removed', (t) => {
  const f = fixture(t),
    source = f.save({ enabled: true }).sources[0]!,
    original = f.config.getSources(f.identity)[0]!;
  renameSync(f.root, f.root + '-old');
  mkdirSync(f.root);
  assert.equal(f.config.isCurrent(original, f.identity), false);
  assert.equal(f.config.read().sources[0]!.current, false);
  assert.throws(
    () =>
      f.config.handle({
        action: 'source-enabled',
        expectedRevision: 1,
        id: source.id,
        enabled: true,
      }),
    /已变化/,
  );
  f.config.handle({ action: 'source-enabled', expectedRevision: 1, id: source.id, enabled: false });
  f.save({ id: source.id, enabled: true });
  assert.equal(f.config.getSources(f.identity).length, 1);
  rmSync(f.root, { recursive: true });
  f.config.handle({ action: 'source-remove', expectedRevision: 3, id: source.id });
  assert.equal(f.config.read().sources.length, 0);
});

test('Skills roots reject private data in either direction, symlink leaves and malformed requests, while parent aliases normalize', (t) => {
  const f = fixture(t),
    child = join(f.data, 'child');
  mkdirSync(child);
  for (const rootPath of [f.data, child, f.directory])
    assert.throws(() => f.save({ rootPath }), /私有数据目录/);
  const alias = join(f.directory, 'alias');
  symlinkSync(f.root, alias);
  assert.throws(() => f.save({ rootPath: alias }), /符号链接/);
  const parentAlias = join(f.directory, 'parent-alias');
  symlinkSync(f.directory, parentAlias);
  assert.equal(f.save({ rootPath: join(parentAlias, 'skills') }).sources[0]!.rootPath, f.root);
  for (const extra of [
    { rootPath: 'relative' },
    { rootPath: '~/.agents' },
    { rootPath: 'a\0b' },
    { enabled: 'true' },
    { command: 'anything' },
  ])
    assert.throws(() => f.save(extra), /请求无效/);
  assert.throws(() => f.save({ rootPath: join(f.directory, 'missing') }), /不可用/);
  assert.throws(() => f.save(), /已经登记/);
  f.options.privateRoots.push(f.root);
  assert.equal(f.config.read().sources[0]!.current, false);
});

test('Skills private config refuses project paths, unsafe file permissions, symlink files, corruption and a changed account', (t) => {
  const f = fixture(t);
  assert.throws(
    () => new SkillsConfig(join(f.project, 'skills-v1.json'), f.options).read(),
    /项目目录外/,
  );
  const alias = join(f.directory, 'project-alias');
  symlinkSync(f.project, alias);
  assert.throws(
    () => new SkillsConfig(join(alias, 'skills-v1.json'), f.options).read(),
    /项目目录外/,
  );
  f.save();
  chmodSync(f.file, 0o644);
  assert.throws(() => f.config.read(), /权限/);
  chmodSync(f.file, 0o600);
  renameSync(f.file, f.file + '-saved');
  symlinkSync(f.file + '-saved', f.file);
  assert.throws(() => f.config.read(), /安全读取/);
  rmSync(f.file);
  renameSync(f.file + '-saved', f.file);
  f.identity = { ...f.identity, userId: 'different-user' };
  assert.throws(() => f.config.read(), /主机账号/);
  f.identity = { ...f.identity, userId: 'synthetic-user' };
  f.projects = [f.directory];
  assert.throws(() => f.config.read(), /项目目录外/);
  f.projects = [f.project];
  writeFileSync(f.file, '{');
  assert.throws(() => f.config.read(), /安全读取/);
});

test('failed Skills persistence preserves the prior revision and bindings, while notification failure cannot reverse a commit', (t) => {
  const f = fixture(t),
    source = f.save({ enabled: true }).sources[0]!,
    previous = readFileSync(f.file, 'utf8');
  const failed = new SkillsConfig(f.file, {
    ...f.options,
    write() {
      throw new Error('/private/synthetic');
    },
  });
  assert.throws(
    () => failed.handle({ action: 'source-remove', expectedRevision: 1, id: source.id }),
    (e) => e instanceof Error && /保存失败/.test(e.message) && !e.message.includes('/private'),
  );
  assert.equal(readFileSync(f.file, 'utf8'), previous);
  const notices = new SkillsConfig(f.file, {
    ...f.options,
    changed() {
      throw new Error('notice loss');
    },
  });
  assert.equal(
    notices.handle({ action: 'source-remove', expectedRevision: 1, id: source.id }).revision,
    2,
  );
});

test('Skills registrations retain all twenty permitted roots and explicitly reject overflow', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 21; i++) mkdirSync(join(f.directory, 'source-' + i));
  for (let i = 0; i < 20; i++)
    f.save({ rootPath: join(f.directory, 'source-' + i), enabled: true });
  assert.equal(f.config.getSources(f.identity).length, 20);
  assert.throws(() => f.save({ rootPath: join(f.directory, 'source-20') }), /超过限制/);
  assert.equal(f.config.read().revision, 20);
});

test('Skills read leases verify configuration snapshots without rediscovering sources', (t) => {
  const f = fixture(t);
  f.save({ enabled: true });
  let scans = 0;
  const getSources = f.config.getSources.bind(f.config);
  f.config.getSources = (scope) => {
    scans++;
    return getSources(scope);
  };
  const lease = f.config.createReadLease(f.identity);
  assert.equal(lease.sources.length, 1);
  for (let index = 0; index < 100; index++) lease.assertCurrent();
  assert.equal(scans, 1);
  writeFileSync(join(f.data, 'unrelated.txt'), 'unrelated local activity');
  lease.assertCurrent();
  assert.equal(scans, 1);
});

test('Skills read leases reject configuration revoke, delete, replacement, permissions and in-place edits', async (t) => {
  for (const change of ['revoke', 'delete', 'replace', 'chmod', 'edit', 'ancestor'] as const) {
    await t.test(change, (t) => {
      const f = fixture(t),
        saved = f.save({ enabled: true });
      const lease = f.config.createReadLease(f.identity);
      if (change === 'revoke')
        f.config.handle({
          action: 'source-enabled',
          expectedRevision: 1,
          id: saved.sources[0]!.id,
          enabled: false,
        });
      if (change === 'delete') rmSync(f.file);
      if (change === 'replace') {
        const content = readFileSync(f.file);
        renameSync(f.file, f.file + '.old');
        writeFileSync(f.file, content, { mode: 0o600 });
      }
      if (change === 'chmod') chmodSync(f.file, 0o644);
      if (change === 'edit') writeFileSync(f.file, '{}');
      if (change === 'ancestor') {
        renameSync(f.data, f.data + '-old');
        mkdirSync(f.data);
        renameSync(join(f.data + '-old', 'skills-v1.json'), f.file);
      }
      assert.throws(
        () => lease.assertCurrent(),
        (error) =>
          error instanceof Error &&
          /已变化/.test(error.message) &&
          !error.message.includes(f.directory),
      );
    });
  }
});

test('Skills read leases reject first config creation and creation of a missing private ancestor', (t) => {
  const f = fixture(t),
    absent = f.config.createReadLease(f.identity);
  assert.deepEqual(absent.sources, []);
  absent.assertCurrent();
  f.save();
  assert.throws(() => absent.assertCurrent(), /已变化/);
  const missingRoot = join(f.directory, 'missing', 'nested');
  const missing = new SkillsConfig(join(missingRoot, 'skills-v1.json'), f.options).createReadLease(
    f.identity,
  );
  missing.assertCurrent();
  mkdirSync(dirname(missingRoot));
  assert.throws(() => missing.assertCurrent(), /已变化/);
});

test('Skills read leases reject a changed account, scope and retargeted parent alias', (t) => {
  const f = fixture(t);
  f.save({ enabled: true });
  for (const key of ['workspaceId', 'machineId', 'userId'] as const)
    assert.throws(() => f.config.createReadLease({ ...f.identity, [key]: 'foreign' }), /执行范围/);
  const current = f.config.createReadLease(f.identity);
  f.identity = { ...f.identity, userId: 'different' };
  assert.throws(() => current.assertCurrent(), /已变化/);
  f.identity = { ...f.identity, userId: 'synthetic-user' };
  const alias = join(f.directory, 'alias');
  symlinkSync(f.data, alias);
  const aliased = new SkillsConfig(join(alias, 'skills-v1.json'), f.options).createReadLease(
    f.identity,
  );
  aliased.assertCurrent();
  rmSync(alias);
  symlinkSync(f.data, alias);
  assert.throws(() => aliased.assertCurrent(), /已变化/);
});

test('Skills read lease creation refuses an authorization change during initial discovery', (t) => {
  const f = fixture(t),
    saved = f.save({ enabled: true });
  const original = f.config.getSources.bind(f.config);
  f.config.getSources = (scope) => {
    const sources = original(scope);
    f.config.handle({
      action: 'source-enabled',
      expectedRevision: 1,
      id: saved.sources[0]!.id,
      enabled: false,
    });
    return sources;
  };
  assert.throws(() => f.config.createReadLease(f.identity), /已变化/);
});
