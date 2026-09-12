import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '../src/protocol';
import { gitRepositoryStateSchema } from '../src/git-protocol';
import {
  readProjectGit,
  prepareProjectWorktree,
  inspectProjectWorktree,
  removeProjectWorktree,
  validateManagedWorktreeRoot,
  type WorktreePlan,
} from '../src/runtime/project-git';

function fixture(t: { after(fn: () => void): void }, initialized = true) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'moor-project-git-')));
  const root = join(temporary, 'project'),
    managedRoot = join(temporary, 'managed');
  mkdirSync(root);
  mkdirSync(managedRoot, { mode: 0o700 });
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };
  const gitAt = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const git = (...args: string[]) => gitAt(root, ...args);
  const write = (path: string, text: string) => {
    const pieces = path.split('/');
    if (pieces.length > 1) mkdirSync(join(root, ...pieces.slice(0, -1)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  if (initialized) {
    git('init', '--quiet', '-b', 'main');
    git('config', 'user.name', 'Synthetic Moor');
    git('config', 'user.email', 'synthetic@example.invalid');
    write('.gitignore', 'ignored.txt\nignored-dir/\n');
    write('README.md', 'synthetic baseline\n');
    write('packages/app/文件.txt', 'synthetic project baseline\n');
    write('other/private-name.txt', 'synthetic other project\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'synthetic baseline');
  }
  const plan = (name: string): WorktreePlan => ({
    targetPath: join(managedRoot, name),
    baseBranch: 'main',
    expectedOid: git('rev-parse', 'HEAD').trim(),
    newBranch: 'moor/' + name,
  });
  return { temporary, root, managedRoot, git, gitAt, write, plan };
}
const rejected = (error: unknown) => error instanceof AppError && error.rejected === true;

test('Git state is bounded and exposes only relative project paths with outside changes summarized', async (t) => {
  const f = fixture(t),
    project = join(f.root, 'packages/app');
  f.write('packages/app/文件.txt', 'synthetic local edit\n');
  f.write('other/private-name.txt', 'synthetic outside edit\n');
  const result = await readProjectGit(project);
  assert.equal(result.state.kind, 'git');
  assert.equal(result.state.branch, 'main');
  assert.equal(result.state.writeSupported, true, JSON.stringify(result.state));
  assert.equal(result.state.dirty, true);
  assert.equal(result.state.outsideProjectChanges, true);
  assert.deepEqual(result.state.changes, [{ path: '文件.txt', index: ' ', worktree: 'M' }]);
  assert.equal(result.repository!.projectRelativePath, 'packages/app');
  assert.equal(JSON.stringify(result.state).includes(f.temporary), false);
  assert.equal(JSON.stringify(result.state).includes('private-name'), false);
  assert.equal(gitRepositoryStateSchema.safeParse(result.state).success, true);
  assert.equal((await readProjectGit(project)).state.version, result.state.version);
  f.write('packages/app/new.txt', 'synthetic new file');
  assert.notEqual((await readProjectGit(project)).state.version, result.state.version);
});

test('ordinary directory and unborn repository return complete unavailable/write-disabled views', async (t) => {
  const f = fixture(t, false);
  const directory = await readProjectGit(f.root);
  assert.equal(directory.state.kind, 'unavailable');
  assert.equal(directory.state.writeSupported, false);
  assert.equal(directory.repository, undefined);
  f.git('init', '--quiet', '-b', 'main');
  const unborn = await readProjectGit(f.root);
  assert.equal(unborn.state.kind, 'git');
  assert.equal(unborn.state.headOid, undefined);
  assert.equal(unborn.state.writeSupported, false);
  assert.deepEqual(unborn.state.branches, []);
  assert.equal(gitRepositoryStateSchema.safeParse(unborn.state).success, true);
});

test('two managed worktrees preserve subproject cwd and isolate changes from a dirty source', async (t) => {
  const f = fixture(t),
    project = join(f.root, 'packages/app');
  f.write('packages/app/文件.txt', 'synthetic source dirty\n');
  const { repository } = await readProjectGit(project);
  assert(repository);
  const first = await prepareProjectWorktree(repository, f.plan('one'));
  const second = await prepareProjectWorktree(repository, f.plan('two'));
  assert.equal(first.cwd, join(first.plan.targetPath, 'packages/app'));
  assert.equal(readFileSync(join(first.cwd, '文件.txt'), 'utf8'), 'synthetic project baseline\n');
  writeFileSync(join(first.cwd, '文件.txt'), 'synthetic isolated edit\n');
  assert.equal(readFileSync(join(second.cwd, '文件.txt'), 'utf8'), 'synthetic project baseline\n');
  assert.equal(readFileSync(join(project, '文件.txt'), 'utf8'), 'synthetic source dirty\n');
  assert.equal(f.git('branch', '--show-current').trim(), 'main');
  assert.equal((await readProjectGit(first.cwd)).repository!.id, repository.id);
  validateManagedWorktreeRoot(repository, first);
  const inspected = await inspectProjectWorktree(repository, first);
  assert.equal(inspected.status, 'ready');
  assert(inspected.status === 'ready' && inspected.state.dirty);
});

test('branch conflict, stale base, magic branch syntax and existing target reject before side effects', async (t) => {
  const f = fixture(t),
    { repository } = await readProjectGit(f.root);
  assert(repository);
  f.git('branch', 'moor/conflict');
  for (const input of [
    f.plan('conflict'),
    { ...f.plan('stale'), expectedOid: '0'.repeat(40) },
    { ...f.plan('magic'), baseBranch: '@{-1}' },
    { ...f.plan('invalid'), newBranch: '--force' },
    { ...f.plan('inside'), targetPath: join(f.root, 'inside') },
  ]) {
    await assert.rejects(prepareProjectWorktree(repository, input), rejected);
    assert.equal(existsSync(input.targetPath), false);
  }
  const target = f.plan('existing');
  mkdirSync(target.targetPath);
  writeFileSync(join(target.targetPath, 'keep.txt'), 'synthetic operator data');
  await assert.rejects(prepareProjectWorktree(repository, target), rejected);
  assert.equal(
    readFileSync(join(target.targetPath, 'keep.txt'), 'utf8'),
    'synthetic operator data',
  );
  assert.equal(f.git('worktree', 'list', '--porcelain').match(/^worktree /gm)?.length, 1);
});

test('selected commit must contain the registered project directory', async (t) => {
  const f = fixture(t);
  f.git('branch', 'without-project');
  f.git('checkout', '--quiet', 'without-project');
  f.git('rm', '-r', '--quiet', 'packages');
  f.git('commit', '--quiet', '-m', 'synthetic remove subproject');
  const base = f.git('rev-parse', 'HEAD').trim();
  f.git('checkout', '--quiet', 'main');
  const { repository } = await readProjectGit(join(f.root, 'packages/app'));
  assert(repository);
  const input = { ...f.plan('missing-project'), baseBranch: 'without-project', expectedOid: base };
  await assert.rejects(prepareProjectWorktree(repository, input), rejected);
  assert.equal(existsSync(input.targetPath), false);
});

test('managed cleanup refuses dirty, untracked and ignored files and preserves the branch', async (t) => {
  const f = fixture(t),
    { repository } = await readProjectGit(f.root);
  assert(repository);
  const managed = await prepareProjectWorktree(repository, f.plan('cleanup'));
  for (const [path, text] of [
    ['README.md', 'synthetic tracked edit'],
    ['untracked.txt', 'synthetic untracked'],
    ['ignored.txt', 'synthetic ignored'],
  ]) {
    writeFileSync(join(managed.cwd, path!), text!);
    const state = (await readProjectGit(managed.cwd)).state;
    assert.equal(state.dirty, true);
    await assert.rejects(
      removeProjectWorktree(repository, managed, { expectedStateVersion: state.version }),
      rejected,
    );
    assert.equal(readFileSync(join(managed.cwd, path!), 'utf8'), text);
    if (path === 'README.md') f.gitAt(managed.cwd, 'restore', '--', path);
    else rmSync(join(managed.cwd, path!));
  }
  const state = (await readProjectGit(managed.cwd)).state;
  assert.deepEqual(
    await removeProjectWorktree(repository, managed, { expectedStateVersion: state.version }),
    { removed: true },
  );
  assert.equal(existsSync(managed.plan.targetPath), false);
  assert.equal((await inspectProjectWorktree(repository, managed)).status, 'missing');
  assert.equal(
    f.git('show-ref', '--verify', '--hash', 'refs/heads/' + managed.plan.newBranch).trim(),
    managed.plan.expectedOid,
  );
});

test('cleanup rechecks ignored files and Git metadata at the final deterministic checkpoint', async (t) => {
  const f = fixture(t),
    { repository } = await readProjectGit(f.root);
  assert(repository);
  const managed = await prepareProjectWorktree(repository, f.plan('late-dirty'));
  const state = (await readProjectGit(managed.cwd)).state;
  await assert.rejects(
    removeProjectWorktree(
      repository,
      managed,
      { expectedStateVersion: state.version },
      {
        checkpoint(stage) {
          if (stage === 'before-remove')
            writeFileSync(join(managed.cwd, 'ignored.txt'), 'synthetic late ignored data');
        },
      },
    ),
    rejected,
  );
  assert.equal(
    readFileSync(join(managed.cwd, 'ignored.txt'), 'utf8'),
    'synthetic late ignored data',
  );
});

test('receipt loss leaves one worktree inspectable by its original plan and never recreates it', async (t) => {
  const f = fixture(t),
    { repository } = await readProjectGit(f.root);
  assert(repository);
  const plan = f.plan('receipt-loss');
  await assert.rejects(
    prepareProjectWorktree(repository, plan, {
      checkpoint(stage) {
        if (stage === 'after-prepare') throw new Error('synthetic receipt loss');
      },
    }),
    (error) => error instanceof AppError && !error.rejected,
  );
  const recovered = await inspectProjectWorktree(repository, plan);
  assert.equal(recovered.status, 'ready');
  assert(recovered.status === 'ready');
  await assert.rejects(prepareProjectWorktree(repository, plan), rejected);
  assert.equal(f.git('worktree', 'list', '--porcelain').match(/^worktree /gm)?.length, 2);
  writeFileSync(join(recovered.managed.cwd, 'README.md'), 'synthetic later edit');
  assert.equal((await inspectProjectWorktree(repository, plan)).status, 'unknown');
  assert.equal((await inspectProjectWorktree(repository, recovered.managed)).status, 'ready');
});

test('missing directory with stale Git registration and replaced target identities stay unknown', async (t) => {
  const f = fixture(t),
    { repository } = await readProjectGit(f.root);
  assert(repository);
  const managed = await prepareProjectWorktree(repository, f.plan('missing'));
  renameSync(managed.plan.targetPath, managed.plan.targetPath + '-moved');
  assert.equal((await inspectProjectWorktree(repository, managed)).status, 'unknown');
  mkdirSync(managed.plan.targetPath);
  writeFileSync(join(managed.plan.targetPath, 'keep.txt'), 'synthetic foreign directory');
  assert.throws(() => validateManagedWorktreeRoot(repository, managed));
  assert.equal((await inspectProjectWorktree(repository, managed)).status, 'unknown');
  await assert.rejects(
    removeProjectWorktree(repository, managed, {
      expectedStateVersion: 'sha256:' + '0'.repeat(64),
    }),
    rejected,
  );
  assert.equal(
    readFileSync(join(managed.plan.targetPath, 'keep.txt'), 'utf8'),
    'synthetic foreign directory',
  );
});

test('linked source .git pointer and managed admin commondir/gitdir substitutions are rejected', async (t) => {
  const f = fixture(t),
    other = fixture(t);
  const { repository: base } = await readProjectGit(f.root);
  assert(base);
  const linked = await prepareProjectWorktree(base, f.plan('source'));
  const { repository } = await readProjectGit(linked.cwd);
  assert(repository);
  const original = readFileSync(join(linked.cwd, '.git'));
  writeFileSync(join(linked.cwd, '.git'), 'gitdir: ' + join(other.root, '.git') + '\n');
  await assert.rejects(prepareProjectWorktree(repository, f.plan('redirected')), rejected);
  assert.equal(existsSync(f.plan('redirected').targetPath), false);
  assert.throws(() => validateManagedWorktreeRoot(base, linked));
  writeFileSync(join(linked.cwd, '.git'), original);
  for (const [name, value] of [
    ['commondir', join(other.root, '.git')],
    ['gitdir', join(other.root, '.git')],
  ]) {
    const path = join(linked.gitDirIdentity.path, name!),
      before = readFileSync(path);
    writeFileSync(path, value + '\n');
    assert.throws(() => validateManagedWorktreeRoot(base, linked));
    assert.equal((await inspectProjectWorktree(base, linked)).status, 'unknown');
    writeFileSync(path, before);
  }
});

test('directory and pointer symlinks cannot replace a managed worktree lease', async (t) => {
  const f = fixture(t),
    { repository } = await readProjectGit(f.root);
  assert(repository);
  const managed = await prepareProjectWorktree(repository, f.plan('pointer'));
  const marker = join(managed.cwd, '.git');
  renameSync(marker, marker + '.saved');
  symlinkSync(marker + '.saved', marker);
  assert.throws(() => validateManagedWorktreeRoot(repository, managed));
  assert.equal((await inspectProjectWorktree(repository, managed)).status, 'unknown');
});

test('executable hooks, filters and fsmonitor configuration never execute through reads or preparation', async (t) => {
  const f = fixture(t),
    { repository } = await readProjectGit(f.root);
  assert(repository);
  const marker = join(f.temporary, 'executed');
  const hook = join(f.root, '.git/hooks/post-checkout');
  writeFileSync(
    hook,
    '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(' +
      JSON.stringify(marker) +
      ', "unsafe");\n',
  );
  chmodSync(hook, 0o755);
  let state = (await readProjectGit(f.root)).state;
  assert.equal(state.writeSupported, false);
  await assert.rejects(prepareProjectWorktree(repository, f.plan('hook')), rejected);
  assert.equal(existsSync(marker), false);
  rmSync(hook);
  for (const key of [
    'filter.synthetic.clean',
    'filter.synthetic.smudge',
    'filter.synthetic.process',
    'core.fsmonitor',
    'core.hooksPath',
  ]) {
    f.git('config', key, '/synthetic/must-not-execute');
    state = (await readProjectGit(f.root)).state;
    assert.equal(state.writeSupported, false, key);
    assert.equal(state.partial, true);
    assert.equal(JSON.stringify(state).includes('/synthetic/must-not-execute'), false);
    await assert.rejects(prepareProjectWorktree(repository, f.plan('config')), rejected);
    f.git('config', '--unset', key);
  }
  assert.equal(existsSync(marker), false);
});

test('submodule, sparse and hidden index changes block writes even outside the registered subproject', async (t) => {
  const f = fixture(t),
    project = join(f.root, 'packages/app');
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    f.git('update-index', flag, 'README.md');
    assert.equal((await readProjectGit(project)).state.writeSupported, false);
    f.git('update-index', flag.replace('--', '--no-'), 'README.md');
  }
  f.git('config', 'core.sparseCheckout', 'true');
  assert.equal((await readProjectGit(project)).state.writeSupported, false);
  f.git('config', '--unset', 'core.sparseCheckout');
  f.git(
    'update-index',
    '--add',
    '--cacheinfo',
    '160000,' + f.git('rev-parse', 'HEAD').trim() + ',submodule',
  );
  assert.equal((await readProjectGit(project)).state.writeSupported, false);
});

test('checkout filter attributes in the selected baseline reject without creating the branch or target', async (t) => {
  const f = fixture(t);
  f.write('.gitattributes', '*.dat filter=synthetic\n');
  f.git('add', '.gitattributes');
  f.git('commit', '--quiet', '-m', 'synthetic attributes');
  const { repository } = await readProjectGit(f.root);
  assert(repository);
  const plan = f.plan('attributes');
  await assert.rejects(prepareProjectWorktree(repository, plan), rejected);
  assert.equal(existsSync(plan.targetPath), false);
});

test('read output and public lists have explicit limits and never authorize cleanup after truncation', async (t) => {
  const f = fixture(t);
  const limited = await readProjectGit(f.root, { outputBytes: 32 });
  assert.equal(limited.state.partial, true);
  assert.equal(limited.state.writeSupported, false);
  for (let index = 0; index < 501; index++) f.write('many/' + index + '.txt', 'synthetic');
  const state = (await readProjectGit(f.root)).state;
  assert.equal(state.changes.length, 500);
  assert.equal(state.partial, true);
  assert.equal(state.writeSupported, false);
  assert(Buffer.byteLength(JSON.stringify(state)) < 2 * 1024 * 1024);
});

test('managed HEAD can advance on its original branch while plan-only recovery remains conservative', async (t) => {
  const f = fixture(t),
    { repository } = await readProjectGit(f.root);
  assert(repository);
  const managed = await prepareProjectWorktree(repository, f.plan('advance'));
  writeFileSync(join(managed.cwd, 'README.md'), 'synthetic committed edit');
  f.gitAt(managed.cwd, 'add', 'README.md');
  f.gitAt(managed.cwd, 'commit', '--quiet', '-m', 'synthetic advance');
  assert.equal((await inspectProjectWorktree(repository, managed)).status, 'ready');
  assert.equal((await inspectProjectWorktree(repository, managed.plan)).status, 'unknown');
  const state = (await readProjectGit(managed.cwd)).state;
  await removeProjectWorktree(repository, managed, { expectedStateVersion: state.version });
  assert.equal(
    f.git('show', 'refs/heads/' + managed.plan.newBranch + ':README.md'),
    'synthetic committed edit',
  );
});

test('inherited Git routing variables cannot redirect a registered repository', async (t) => {
  const f = fixture(t),
    other = fixture(t);
  const previous = process.env.GIT_DIR,
    previousTree = process.env.GIT_WORK_TREE;
  process.env.GIT_DIR = join(other.root, '.git');
  process.env.GIT_WORK_TREE = other.root;
  try {
    const result = await readProjectGit(f.root);
    assert.equal(result.repository!.rootPath, f.root);
    const plan = f.plan('environment');
    await prepareProjectWorktree(result.repository!, plan);
    assert.equal(
      f.git('show-ref', '--verify', '--hash', 'refs/heads/' + plan.newBranch).trim(),
      plan.expectedOid,
    );
    assert.equal(other.git('branch', '--list', plan.newBranch), '');
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
    if (previousTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = previousTree;
  }
});

test('actual Git core.worktree reconfiguration cannot reuse an old repository lease', async (t) => {
  const f = fixture(t),
    other = fixture(t),
    { repository } = await readProjectGit(f.root);
  assert(repository);
  const plan = f.plan('config-redirect');
  f.git('config', 'core.worktree', other.root);
  await assert.rejects(prepareProjectWorktree(repository, plan), rejected);
  assert.equal(existsSync(plan.targetPath), false);
  assert.equal(other.git('branch', '--list', plan.newBranch), '');
});

test('synchronous managed leases reject a switched branch and detached HEAD', async (t) => {
  const f = fixture(t),
    { repository } = await readProjectGit(f.root);
  assert(repository);
  const managed = await prepareProjectWorktree(repository, f.plan('lease-branch'));
  validateManagedWorktreeRoot(repository, managed);
  f.gitAt(managed.cwd, 'switch', '--quiet', '-c', 'synthetic-other-branch');
  assert.throws(() => validateManagedWorktreeRoot(repository, managed), AppError);
  assert.equal((await inspectProjectWorktree(repository, managed)).status, 'unknown');
  f.gitAt(managed.cwd, 'switch', '--quiet', managed.plan.newBranch);
  validateManagedWorktreeRoot(repository, managed);
  f.gitAt(managed.cwd, 'switch', '--quiet', '--detach');
  assert.throws(() => validateManagedWorktreeRoot(repository, managed), AppError);
  assert.equal((await inspectProjectWorktree(repository, managed)).status, 'unknown');
});

test('synchronous managed leases pin common configuration and absent per-worktree configuration', async (t) => {
  const f = fixture(t),
    other = fixture(t),
    { repository } = await readProjectGit(f.root);
  assert(repository);
  const managed = await prepareProjectWorktree(repository, f.plan('lease-config'));
  const commonConfig = join(repository.commonDir, 'config'),
    original = readFileSync(commonConfig),
    state = (await readProjectGit(managed.cwd)).state;
  f.git('config', 'core.worktree', other.root);
  assert.throws(() => validateManagedWorktreeRoot(repository, managed), AppError);
  await assert.rejects(
    removeProjectWorktree(repository, managed, { expectedStateVersion: state.version }),
    rejected,
  );
  assert.equal(existsSync(managed.cwd), true);
  writeFileSync(commonConfig, original);
  // Git config updates atomically replace the file; restoring its contents cannot
  // restore the original identity or silently rebind an existing session.
  assert.throws(() => validateManagedWorktreeRoot(repository, managed), AppError);

  const fresh = await readProjectGit(f.root);
  assert(fresh.repository);
  const second = await prepareProjectWorktree(fresh.repository, f.plan('lease-worktree-config'));
  const worktreeConfig = join(second.gitDirIdentity.path, 'config.worktree');
  assert.equal(existsSync(worktreeConfig), false);
  writeFileSync(worktreeConfig, '[core]\n\tworktree = ' + other.root + '\n');
  assert.throws(() => validateManagedWorktreeRoot(fresh.repository!, second), AppError);
  assert.equal((await inspectProjectWorktree(fresh.repository, second)).status, 'unknown');
});

test('synchronous managed leases pin included configuration content and identity', async (t) => {
  const f = fixture(t),
    included = join(f.temporary, 'included-config');
  writeFileSync(included, '[synthetic]\n\tvalue = initial\n');
  f.git('config', 'include.path', included);
  const { repository } = await readProjectGit(f.root);
  assert(repository);
  const managed = await prepareProjectWorktree(repository, f.plan('lease-include'));
  assert(managed.configs.some((config) => config.path === included));
  validateManagedWorktreeRoot(repository, managed);
  writeFileSync(included, '[synthetic]\n\tvalue = changed\n');
  assert.throws(() => validateManagedWorktreeRoot(repository, managed), AppError);
  assert.equal((await inspectProjectWorktree(repository, managed)).status, 'unknown');
});

test('an initially missing include cannot appear underneath an existing managed lease', async (t) => {
  const f = fixture(t),
    included = join(f.temporary, 'initially-missing-config');
  f.git('config', 'include.path', '../../initially-missing-config');
  const { repository } = await readProjectGit(f.root);
  assert(repository);
  const managed = await prepareProjectWorktree(repository, f.plan('lease-new-include'));
  assert.deepEqual(
    managed.configs.find((config) => config.path === included),
    { path: included },
  );
  validateManagedWorktreeRoot(repository, managed);
  writeFileSync(included, '[synthetic]\n\tvalue = newly present\n');
  assert.throws(() => validateManagedWorktreeRoot(repository, managed), AppError);
  assert.equal((await inspectProjectWorktree(repository, managed)).status, 'unknown');
});

test('attribute scans have an aggregate work limit before any Git write is attempted', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 33; i++) f.write('attributes/' + i + '/.gitattributes', '*.txt text\n');
  f.git('add', 'attributes');
  f.git('commit', '--quiet', '-m', 'synthetic attribute budget');
  const { repository } = await readProjectGit(f.root);
  assert(repository);
  const plan = f.plan('attribute-budget');
  await assert.rejects(prepareProjectWorktree(repository, plan), rejected);
  assert.equal(existsSync(plan.targetPath), false);
  assert.equal(f.git('branch', '--list', plan.newBranch), '');
});
