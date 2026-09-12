import test from 'node:test';
import strict from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTENT_LIMITS } from '../src/content-protocol';
import {
  captureProjectSnapshot,
  compareProjectSnapshots,
  enumerateProjectFiles,
  type ProjectSnapshotOptions,
} from '../src/runtime/project-snapshot';

function project(t: { after(fn: () => void): void }) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'moor-project-snapshot-')));
  const root = join(temporary, 'project');
  mkdirSync(root);
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const write = (path: string, content: string | Buffer) => {
    const parts = path.split('/');
    if (parts.length > 1) mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
  return { temporary, root, write, git };
}
const directoryOnly: ProjectSnapshotOptions = {
  git: async () => {
    throw Object.assign(new Error('synthetic non-repository'), { nonRepository: true });
  },
};

test('automatic Git and directory snapshots exclude reserved GitHub credentials and temporary saves', async (t) => {
  const p = project(t);
  p.write('safe.txt', 'synthetic public source');
  for (const path of [
    'github-v1.json',
    'private/github-v1.json.tmp-save',
    'private/GITHUB-V1.JSON',
    'preview-v1.json',
    'private/preview-v1.json.tmp-save',
    'private/PREVIEW-V1.JSON',
  ])
    p.write(path, '{"token":"synthetic-private-github-token"}');
  for (const options of [directoryOnly, {}]) {
    if (options !== directoryOnly) {
      p.git('init', '--quiet');
      p.git('add', '.');
    }
    const tree = await enumerateProjectFiles(p.root, options),
      snapshot = await captureProjectSnapshot(p.root, options);
    strict.ok(tree.entries.every((entry) => !entry.path.toLowerCase().includes('github-v1.json')));
    strict.ok(tree.entries.every((entry) => !entry.path.toLowerCase().includes('preview-v1.json')));
    strict.ok(tree.issues.some((issue) => issue.reason === 'policy-excluded'));
    strict.equal(JSON.stringify(snapshot).includes('synthetic-private-github-token'), false);
  }
});

test('plain directory tree uses relative paths and explicitly reports filtered/unsupported entries', async (t) => {
  const p = project(t);
  p.write('src/file.txt', 'synthetic file');
  p.write('README.md', '# Synthetic');
  p.write('.env', 'synthetic-private-sentinel');
  p.write('.env.local', 'synthetic-private-sentinel');
  p.write('.env.example', 'SYNTHETIC=example');
  p.write('.npmrc', 'synthetic-private-sentinel');
  p.write('.data/bridge-v3.json', '{"token":"synthetic-private-sentinel"}');
  p.write('.moor/runtime-v1.sqlite', 'synthetic-private-sentinel');
  for (const dir of ['node_modules', 'dist', '.git', 'build', '.cache'])
    p.write(dir + '/hidden.txt', 'excluded');
  mkdirSync(join(p.root, 'empty'));
  symlinkSync(join(p.root, 'src'), join(p.root, 'linked'));
  execFileSync('mkfifo', [join(p.root, 'pipe')]);
  const tree = await enumerateProjectFiles(p.root, directoryOnly);
  strict.equal(tree.source, 'directory');
  strict.equal(tree.partial, true);
  strict.deepEqual(
    tree.entries.map((entry) => entry.path),
    ['.env.example', 'README.md', 'empty', 'src', 'src/file.txt'],
  );
  strict.ok(
    tree.entries.every((entry) => !entry.path.startsWith('/') && Number.isSafeInteger(entry.size)),
  );
  strict.ok(tree.issues.some((issue) => issue.reason === 'directory-ignore-unavailable'));
  strict.ok(
    tree.issues.some((issue) => issue.reason === 'policy-excluded' && issue.path === '.env'),
  );
  strict.ok(tree.issues.some((issue) => issue.reason === 'symlink' && issue.path === 'linked'));
  strict.ok(tree.issues.some((issue) => issue.reason === 'nonregular' && issue.path === 'pipe'));
  strict.equal(JSON.stringify(tree).includes(p.temporary), false);
});

test('Git unborn repository includes tracked and untracked files while respecting ignores and fixed exclusions', async (t) => {
  const p = project(t);
  p.git('init', '--quiet');
  p.write('.gitignore', 'ignored.txt\nignored-dir/\n');
  p.write('tracked.txt', 'tracked');
  p.git('add', '--', 'tracked.txt', '.gitignore');
  p.write('untracked.txt', 'untracked');
  p.write('ignored.txt', 'ignored');
  p.write('ignored-dir/hidden.txt', 'ignored');
  p.write('node_modules/tracked.txt', 'dependency');
  p.git('add', '-f', '--', 'node_modules/tracked.txt');
  const tree = await enumerateProjectFiles(p.root);
  strict.equal(tree.source, 'git');
  strict.deepEqual(
    tree.entries.map((entry) => entry.path),
    ['.gitignore', 'tracked.txt', 'untracked.txt'],
  );
  strict.ok(tree.issues.some((issue) => issue.reason === 'policy-excluded'));
  strict.equal(tree.enumerationComplete, true);
});

test('registered Git subdirectory lists only its subtree with paths relative to that root', async (t) => {
  const p = project(t);
  p.git('init', '--quiet');
  p.write('outside.txt', 'outside');
  p.write('nested/a.txt', 'inside');
  p.write('nested/src/b.txt', 'inside');
  p.git('add', '--', '.');
  const tree = await enumerateProjectFiles(join(p.root, 'nested'));
  strict.equal(tree.source, 'git');
  strict.deepEqual(
    tree.entries.map((entry) => entry.path),
    ['a.txt', 'src', 'src/b.txt'],
  );
  strict.equal(JSON.stringify(tree).includes('outside.txt'), false);
});

test('actual Git execution ignores inherited repository overrides and never runs configured fsmonitor', async (t) => {
  const p = project(t);
  p.git('init', '--quiet');
  p.write('safe.txt', 'safe');
  p.git('add', '--', 'safe.txt');
  const sentinel = join(p.temporary, 'should-not-exist');
  p.git('config', 'core.fsmonitor', `touch ${sentinel}`);
  const old = process.env.GIT_DIR;
  process.env.GIT_DIR = join(p.temporary, 'nonexistent-git');
  t.after(() => {
    if (old === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = old;
  });
  const tree = await enumerateProjectFiles(p.root);
  strict.equal(tree.source, 'git');
  strict.deepEqual(
    tree.entries.map((entry) => entry.path),
    ['safe.txt'],
  );
  strict.throws(() => statSync(sentinel), { code: 'ENOENT' });
});

test('Git unavailable or failed explicitly falls back to a bounded directory view', async (t) => {
  for (const code of ['ENOENT', 'synthetic-failure']) {
    const p = project(t);
    p.write('visible.txt', 'visible');
    const tree = await enumerateProjectFiles(p.root, {
      git: async () => {
        throw Object.assign(new Error('must not leak /private/host'), { code });
      },
    });
    strict.equal(tree.source, 'directory');
    strict.equal(tree.partial, true);
    strict.ok(
      tree.issues.some(
        (issue) => issue.reason === (code === 'ENOENT' ? 'git-unavailable' : 'git-failed'),
      ),
    );
    strict.equal(JSON.stringify(tree).includes('/private/host'), false);
  }
});

test('file snapshots freeze text, preserve binary hashes, and identify oversize metadata without reading it', async (t) => {
  const p = project(t);
  p.write('text.md', '# 中文 synthetic\n');
  p.write('binary.bin', Buffer.from([0, 255, 1, 2]));
  p.write('invalid-utf8.bin', Buffer.from([255, 254]));
  p.write('large.txt', Buffer.alloc(CONTENT_LIMITS.fileBytes + 1, 65));
  const snapshot = await captureProjectSnapshot(p.root, directoryOnly);
  const files = new Map(snapshot.files.map((file) => [file.path, file]));
  strict.equal(files.get('text.md')!.text, '# 中文 synthetic\n');
  strict.equal(files.get('binary.bin')!.state, 'binary');
  strict.ok(files.get('binary.bin')!.version?.startsWith('sha256:'));
  strict.equal(files.get('binary.bin')!.text, undefined);
  strict.equal(files.get('invalid-utf8.bin')!.state, 'binary');
  strict.equal(files.get('large.txt')!.state, 'oversize');
  strict.equal(files.get('large.txt')!.version, undefined);
  strict.ok(
    snapshot.issues.some((issue) => issue.reason === 'oversize' && issue.path === 'large.txt'),
  );
  strict.equal(JSON.stringify(snapshot).includes(p.temporary), false);
  strict.equal(JSON.stringify(snapshot).includes('base64'), false);
});

test('frozen before/after comparison captures addition deletion exact rename modification and binary changes', async (t) => {
  const p = project(t);
  p.write('deleted.txt', 'to delete');
  p.write('old-name.txt', 'unchanged rename bytes');
  p.write('modified.txt', 'before\n');
  p.write('binary.bin', Buffer.from([0, 1]));
  p.write('unchanged.txt', 'stable');
  const before = await captureProjectSnapshot(p.root, directoryOnly);
  rmSync(join(p.root, 'deleted.txt'));
  renameSync(join(p.root, 'old-name.txt'), join(p.root, 'new-name.txt'));
  p.write('added.txt', 'added\n');
  p.write('modified.txt', 'after\n');
  p.write('binary.bin', Buffer.from([0, 2]));
  const after = await captureProjectSnapshot(p.root, directoryOnly),
    diff = compareProjectSnapshots(before, after);
  strict.deepEqual(
    diff.changes.map((change) => [change.path, change.kind]),
    [
      ['added.txt', 'added'],
      ['binary.bin', 'modified'],
      ['deleted.txt', 'deleted'],
      ['modified.txt', 'modified'],
      ['new-name.txt', 'renamed'],
    ],
  );
  strict.equal(
    diff.changes.find((change) => change.kind === 'renamed')!.previousPath,
    'old-name.txt',
  );
  const text = diff.changes.find((change) => change.path === 'modified.txt')!;
  strict.equal(text.before!.text, 'before\n');
  strict.equal(text.after!.text, 'after\n');
  const frozen = JSON.stringify(diff);
  p.write('modified.txt', 'a later turn');
  after.files.find((file) => file.path === 'modified.txt')!.text = 'mutated caller snapshot';
  strict.equal(JSON.stringify(diff), frozen);
});

test('same-size same-mtime text modifications use content hashes and binary renames use exact hashes', async (t) => {
  const p = project(t);
  p.write('file.txt', 'AAAA');
  p.write('old.bin', Buffer.from([0, 1, 2]));
  const stamp = statSync(join(p.root, 'file.txt')),
    before = await captureProjectSnapshot(p.root, directoryOnly);
  p.write('file.txt', 'BBBB');
  utimesSync(join(p.root, 'file.txt'), stamp.atime, stamp.mtime);
  renameSync(join(p.root, 'old.bin'), join(p.root, 'new.bin'));
  const diff = compareProjectSnapshots(before, await captureProjectSnapshot(p.root, directoryOnly));
  strict.equal(diff.changes.find((change) => change.path === 'file.txt')!.kind, 'modified');
  strict.equal(diff.changes.find((change) => change.path === 'new.bin')!.kind, 'renamed');
});

test('directory roots, ancestors and Git candidate symlinks cannot expose external content', async (t) => {
  const p = project(t);
  p.write('safe.txt', 'inside');
  const outside = join(p.temporary, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'outside-sentinel');
  symlinkSync(outside, join(p.root, 'linked'));
  symlinkSync(join(outside, 'secret.txt'), join(p.root, 'leaf.txt'));
  const snapshot = await captureProjectSnapshot(p.root, {
    git: async () => 'linked/secret.txt\0leaf.txt\0safe.txt\0',
  });
  strict.deepEqual(
    snapshot.files.map((file) => file.path),
    ['safe.txt'],
  );
  strict.equal(JSON.stringify(snapshot).includes('outside-sentinel'), false);
  const alias = join(p.temporary, 'alias');
  symlinkSync(p.root, alias);
  await strict.rejects(enumerateProjectFiles(alias, directoryOnly), /符号链接/);
  await strict.rejects(captureProjectSnapshot(alias, directoryOnly), /符号链接/);
});

test('directory replacement at deterministic checkpoints rejects stale enumeration without outside filenames', async (t) => {
  for (const stage of ['directory-opened', 'directory-read'] as const) {
    const p = project(t);
    p.write('inner/file.txt', 'inside');
    const outside = join(p.temporary, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'outside-secret.txt'), 'sentinel');
    let swapped = false;
    const tree = await enumerateProjectFiles(p.root, {
      ...directoryOnly,
      checkpoint(current, path) {
        if (!swapped && current === stage && path === 'inner') {
          swapped = true;
          renameSync(join(p.root, 'inner'), join(p.root, 'original'));
          symlinkSync(outside, join(p.root, 'inner'));
        }
      },
    });
    strict.equal(swapped, true);
    strict.equal(tree.partial, true);
    strict.equal(tree.enumerationComplete, false);
    strict.equal(
      tree.entries.some((entry) => entry.path.includes('outside-secret')),
      false,
    );
  }
});

test('root replacement during enumeration fails safely and errors never reveal absolute paths', async (t) => {
  const p = project(t);
  p.write('file.txt', 'inside');
  await strict.rejects(
    enumerateProjectFiles(p.root, {
      ...directoryOnly,
      checkpoint(stage) {
        if (stage === 'root-checked') {
          renameSync(p.root, p.root + '-old');
          mkdirSync(p.root);
        }
      },
    }),
    (error) =>
      error instanceof Error &&
      !error.message.includes(p.temporary) &&
      /已变化/.test(error.message),
  );
  await strict.rejects(
    captureProjectSnapshot(join(p.root, 'missing'), directoryOnly),
    (error) => error instanceof Error && !error.message.includes(p.temporary),
  );
});

test('observable file edits after read are marked unavailable rather than frozen as valid text', async (t) => {
  const p = project(t);
  p.write('file.txt', 'before');
  const snapshot = await captureProjectSnapshot(p.root, {
    ...directoryOnly,
    checkpoint(stage, path) {
      if (stage === 'after-file' && path === 'file.txt') p.write('file.txt', 'after');
    },
  });
  strict.equal(snapshot.files[0].state, 'unavailable');
  strict.equal(snapshot.files[0].text, undefined);
  strict.ok(snapshot.issues.some((issue) => issue.reason === 'changed'));
});

test('entry depth read-byte and change bounds are explicit and partial baselines do not invent additions or deletions', async (t) => {
  const p = project(t);
  for (const path of ['a.txt', 'b.txt', 'c.txt']) p.write(path, 'abc');
  p.write('deep/inner/file.txt', 'abc');
  const full = await captureProjectSnapshot(p.root, directoryOnly);
  const limited = await captureProjectSnapshot(p.root, {
    ...directoryOnly,
    limits: { entries: 2, bytes: 3 },
  });
  strict.equal(limited.enumerationComplete, false);
  strict.ok(limited.issues.some((issue) => issue.reason === 'entry-limit'));
  strict.ok(limited.issues.some((issue) => issue.reason === 'read-budget'));
  const forward = compareProjectSnapshots(full, limited),
    backward = compareProjectSnapshots(limited, full);
  strict.equal(
    forward.changes.some((change) => change.kind === 'deleted'),
    false,
  );
  strict.equal(
    backward.changes.some((change) => change.kind === 'added'),
    false,
  );
  strict.ok(forward.issues.some((issue) => issue.reason === 'incomplete-baseline'));
  const depth = await enumerateProjectFiles(p.root, { ...directoryOnly, limits: { depth: 1 } });
  strict.ok(depth.issues.some((issue) => issue.reason === 'depth-limit'));
  for (const path of ['a.txt', 'b.txt', 'c.txt']) p.write(path, 'changed');
  const diff = compareProjectSnapshots(full, await captureProjectSnapshot(p.root, directoryOnly), {
    limits: { changes: 1 },
  });
  strict.equal(diff.changes.length, 1);
  strict.ok(diff.issues.some((issue) => issue.reason === 'change-limit' && issue.count === 2));
});

test('tracked deletions are recognized and path traversal from Git candidates is rejected', async (t) => {
  const p = project(t);
  p.git('init', '--quiet');
  p.write('file.txt', 'before');
  p.git('add', '--', 'file.txt');
  const before = await captureProjectSnapshot(p.root);
  rmSync(join(p.root, 'file.txt'));
  const after = await captureProjectSnapshot(p.root),
    diff = compareProjectSnapshots(before, after);
  strict.equal(after.enumerationComplete, true);
  strict.equal(diff.changes[0].kind, 'deleted');
  p.write('safe.txt', 'inside');
  const tree = await enumerateProjectFiles(p.root, {
    git: async () => '../outside\0/absolute\0a/../b\0safe.txt\0',
  });
  strict.deepEqual(
    tree.entries.map((entry) => entry.path),
    ['safe.txt'],
  );
  strict.equal(tree.enumerationComplete, false);
  strict.ok(tree.issues.some((issue) => issue.reason === 'invalid-path'));
});

test('frozen UTF-8 text preserves BOM and line endings exactly', async (t) => {
  const p = project(t);
  const original = '\ufefffirst\r\nsecond\r\n';
  p.write('bom.txt', original);
  const snapshot = await captureProjectSnapshot(p.root, directoryOnly);
  strict.equal(snapshot.files[0].text, original);
});
