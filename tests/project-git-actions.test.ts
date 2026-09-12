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
import { readProjectGit, prepareProjectWorktree } from '../src/runtime/project-git';
import {
  GIT_ACTION_LIMITS,
  inspectCommitCandidate,
  planProjectCommit,
  commitProject,
  inspectProjectCommit,
  pushProject,
  inspectProjectPush,
  type GitPushPlan,
  type GitPushTransport,
} from '../src/runtime/project-git-actions';

const author = { name: 'Synthetic Moor', email: 'synthetic@example.invalid' },
  timestamp = 1767225600000;
function fixture(t: { after(fn: () => unknown): void }, sha256 = false) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'moor-git-write-'))),
    root = join(temporary, 'project'),
    bare = join(temporary, 'remote.git');
  mkdirSync(root);
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };
  const raw = (cwd: string, args: string[], input?: Buffer) =>
    execFileSync('git', ['-C', cwd, ...args], {
      env,
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 40 * 1024 * 1024,
    });
  const git = (...args: string[]) => raw(root, args).toString('utf8').trimEnd();
  const write = (path: string, value: string | Buffer) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  git('init', '-q', '-b', 'main', ...(sha256 ? ['--object-format=sha256'] : []));
  git('config', 'user.name', author.name);
  git('config', 'user.email', author.email);
  write('selected.txt', 'old selected\n');
  write('staged.txt', 'old staged\n');
  write('worktree.txt', 'old worktree\n');
  write('nested/file.txt', 'old nested\n');
  git('add', '.');
  git('commit', '-qm', 'synthetic baseline');
  const baseline = git('rev-parse', 'HEAD');
  raw(temporary, ['init', '--bare', '-q', bare, ...(sha256 ? ['--object-format=sha256'] : [])]);
  raw(bare, ['config', 'receive.denyNonFastForwards', 'true']);
  let receives = 0,
    advertises = 0;
  const packet = (value: string) =>
    Buffer.from((Buffer.byteLength(value) + 4).toString(16).padStart(4, '0') + value);
  const transport: GitPushTransport = {
    async advertise() {
      advertises++;
      return Buffer.concat([
        packet('# service=git-receive-pack\n'),
        Buffer.from('0000'),
        raw(bare, ['receive-pack', '--stateless-rpc', '--advertise-refs', bare]),
      ]);
    },
    async receive(body) {
      receives++;
      return raw(bare, ['receive-pack', '--stateless-rpc', bare], body);
    },
  };
  const plan = async (paths = ['selected.txt'], cwd = root) =>
    planProjectCommit(await inspectCommitCandidate(cwd, paths), {
      message: 'Explicit selected change',
      author,
      timestamp,
    });
  const pushPlan = async (expectedRemoteOid: string | null): Promise<GitPushPlan> => ({
    version: 1,
    repository: (await readProjectGit(root)).repository!,
    branch: 'main',
    headOid: git('rev-parse', 'HEAD'),
    remote: { owner: 'synthetic', repo: 'project', repositoryId: 123 },
    expectedRemoteOid,
  });
  return {
    temporary,
    root,
    bare,
    git,
    raw,
    write,
    baseline,
    plan,
    pushPlan,
    transport,
    calls: () => ({ receives, advertises }),
  };
}
const rejected = (error: unknown) => error instanceof AppError && error.rejected === true;
const unknown = (error: unknown) => error instanceof AppError && error.rejected === false;

test('exact commit plan does not write original objects and commits only selected bytes preserving unselected index/worktree', async (t) => {
  const f = fixture(t);
  f.write('selected.txt', 'selected first staged\n');
  f.git('add', 'selected.txt');
  f.write('selected.txt', 'selected reviewed final\n');
  f.write('staged.txt', 'unselected staged\n');
  f.git('add', 'staged.txt');
  f.write('staged.txt', 'unselected worktree after stage\n');
  f.write('worktree.txt', 'unselected unstaged\n');
  const staged = f.git('rev-parse', ':staged.txt'),
    beforeIndex = readFileSync(join(f.root, '.git/index'));
  const candidate = await inspectCommitCandidate(f.root, ['selected.txt']);
  assert.equal(candidate.files[0]!.beforeText, 'old selected\n');
  assert.equal(candidate.files[0]!.afterText, 'selected reviewed final\n');
  const plan = await f.plan();
  assert.equal(f.git('rev-parse', 'HEAD'), f.baseline);
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), beforeIndex);
  assert.throws(() => f.git('cat-file', '-e', plan.oid));
  let dispatched = 0;
  assert.deepEqual(
    await commitProject(plan, {
      onDispatched: () => {
        assert.equal(
          existsSync(join(f.root, '.git/index.lock')),
          false,
          'durable dispatch precedes the first original Git directory write',
        );
        dispatched++;
      },
    }),
    { oid: plan.oid },
  );
  assert.equal(dispatched, 1);
  assert.equal(f.git('rev-parse', 'HEAD^'), f.baseline);
  assert.equal(f.git('show', 'HEAD:selected.txt'), 'selected reviewed final');
  assert.equal(f.git('show', 'HEAD:staged.txt'), 'old staged');
  assert.equal(f.git('rev-parse', ':staged.txt'), staged);
  assert.equal(
    readFileSync(join(f.root, 'staged.txt'), 'utf8'),
    'unselected worktree after stage\n',
  );
  assert.equal(readFileSync(join(f.root, 'worktree.txt'), 'utf8'), 'unselected unstaged\n');
  assert.equal((await inspectProjectCommit(plan)).status, 'accepted');
  await assert.rejects(commitProject(plan), rejected);
  assert.equal(f.git('rev-list', '--count', 'HEAD'), '2');
});

test('candidate versions bind selected bytes and index; stale content or stage changes reject before dispatch', async (t) => {
  const f = fixture(t);
  f.write('selected.txt', 'first\n');
  const plan = await f.plan();
  let calls = 0;
  f.write('selected.txt', 'second\n');
  await assert.rejects(
    commitProject(plan, {
      onDispatched: () => {
        calls++;
      },
    }),
    rejected,
  );
  assert.notEqual(
    (await inspectCommitCandidate(f.root, ['selected.txt'])).version,
    plan.candidate.version,
  );
  f.write('selected.txt', 'first\n');
  f.write('staged.txt', 'new staged\n');
  f.git('add', 'staged.txt');
  await assert.rejects(
    commitProject(plan, {
      onDispatched: () => {
        calls++;
      },
    }),
    rejected,
  );
  assert.equal(calls, 0);
  assert.equal(f.git('rev-parse', 'HEAD'), f.baseline);
});

test('read-only commit recovery tolerates index stat refresh but never accepts different staged contents', async (t) => {
  const f = fixture(t);
  f.write('selected.txt', 'reviewed\n');
  const plan = await f.plan();
  await commitProject(plan);
  f.git('update-index', '--refresh');
  const index = readFileSync(join(f.root, '.git/index'));
  assert.equal(
    index.equals(Buffer.from(plan.indexAfter, 'base64')),
    false,
    'Git refreshed real stat-cache bytes',
  );
  assert.equal((await inspectProjectCommit(plan)).status, 'accepted');
  assert.deepEqual(
    readFileSync(join(f.root, '.git/index')),
    index,
    'inspection does not rewrite the index',
  );
  f.write('selected.txt', 'new user-staged content\n');
  f.git('add', 'selected.txt');
  assert.equal((await inspectProjectCommit(plan)).status, 'unknown');
  assert.equal(f.git('rev-parse', 'HEAD'), plan.oid);
});

test('planning compares the exact read bytes when an external edit changes and restores the reviewed file', async (t) => {
  const f = fixture(t);
  f.write('selected.txt', 'reviewed A\n');
  const candidate = await inspectCommitCandidate(f.root, ['selected.txt']);
  await assert.rejects(
    planProjectCommit(
      candidate,
      { message: 'Reviewed A', author, timestamp },
      {
        checkpoint: (stage, path) => {
          if (path !== 'selected.txt') return;
          if (stage === 'before-plan-file') f.write(path, 'unreviewed B\n');
          if (stage === 'after-plan-file') f.write(path, 'reviewed A\n');
        },
      },
    ),
    rejected,
  );
  assert.equal(f.git('rev-parse', 'HEAD'), f.baseline);
  assert.equal((await inspectCommitCandidate(f.root, ['selected.txt'])).version, candidate.version);
});

test('add/delete pair, executable mode, binary and truncated previews stay exact in SHA-256 commits', async (t) => {
  const f = fixture(t, true);
  rmSync(join(f.root, 'selected.txt'));
  f.write('renamed.txt', 'old selected\n');
  f.write('script.sh', '#!/bin/sh\nexit 0\n');
  chmodSync(join(f.root, 'script.sh'), 0o755);
  const binary = Buffer.from([0, 1, 2, 255]);
  f.write('binary.bin', binary);
  f.write('long.txt', 'x'.repeat(17000));
  const plan = await f.plan(['selected.txt', 'renamed.txt', 'script.sh', 'binary.bin', 'long.txt']);
  assert.equal(plan.oid.length, 64);
  assert.equal(plan.candidate.files.find((file) => file.path === 'binary.bin')!.binary, true);
  assert.equal(
    plan.candidate.files.find((file) => file.path === 'long.txt')!.afterText!.length,
    16000,
  );
  assert.equal(plan.candidate.files.find((file) => file.path === 'long.txt')!.truncated, true);
  await commitProject(plan);
  assert.equal(f.git('ls-tree', 'HEAD', 'script.sh').startsWith('100755'), true);
  assert.deepEqual(f.raw(f.root, ['show', 'HEAD:binary.bin']), binary);
  assert.throws(() => f.git('cat-file', '-e', 'HEAD:selected.txt'));
  assert.equal(f.git('show', 'HEAD:renamed.txt'), 'old selected');
  await pushProject(await f.pushPlan(null), { token: 'synthetic', transport: f.transport });
  assert.equal(f.raw(f.bare, ['rev-parse', 'refs/heads/main']).toString().trim(), plan.oid);
});

test('selected byte quota accepts exactly 8 MiB and rejects one additional selected byte', async (t) => {
  const f = fixture(t),
    paths: string[] = [];
  for (let index = 0; index < 8; index++) {
    const path = 'file-' + index + '.bin';
    paths.push(path);
    f.write(path, Buffer.alloc(GIT_ACTION_LIMITS.fileBytes));
  }
  const candidate = await inspectCommitCandidate(f.root, paths);
  assert.equal(
    candidate.files.reduce((total, file) => total + file.byteLength, 0),
    GIT_ACTION_LIMITS.selectedBytes,
  );
  f.write('extra.bin', Buffer.from([0]));
  await assert.rejects(inspectCommitCandidate(f.root, [...paths, 'extra.bin']), rejected);
  assert.equal(f.git('rev-parse', 'HEAD'), f.baseline);
});

test('subproject managed execution commits in its own branch and cannot select sibling or private paths', async (t) => {
  const f = fixture(t),
    source = (await readProjectGit(join(f.root, 'nested'))).repository!;
  const managed = await prepareProjectWorktree(source, {
    targetPath: join(f.temporary, 'managed'),
    baseBranch: 'main',
    expectedOid: f.baseline,
    newBranch: 'codex/isolated',
  });
  writeFileSync(join(managed.cwd, 'file.txt'), 'isolated edit\n');
  const plan = await f.plan(['file.txt'], managed.cwd);
  await commitProject(plan);
  assert.equal(f.git('rev-parse', 'HEAD'), f.baseline);
  assert.equal(f.raw(managed.cwd, ['show', 'HEAD:nested/file.txt']).toString(), 'isolated edit\n');
  for (const path of [
    '../selected.txt',
    '.git/config',
    'github-v1.json',
    'sub/github-v1.json.tmp-one',
  ])
    await assert.rejects(inspectCommitCandidate(managed.cwd, [path]), rejected);
});

test('symlinks, active conflicts, filters, hooks, alternate object paths and selected size limits fail safely', async (t) => {
  const f = fixture(t);
  f.write('selected.txt', 'changed\n');
  symlinkSync(join(f.root, 'selected.txt'), join(f.root, 'link.txt'));
  await assert.rejects(inspectCommitCandidate(f.root, ['link.txt']), rejected);
  rmSync(join(f.root, 'link.txt'));
  writeFileSync(join(f.root, '.git/MERGE_HEAD'), f.baseline + '\n');
  await assert.rejects(f.plan(), rejected);
  rmSync(join(f.root, '.git/MERGE_HEAD'));
  const marker = join(f.temporary, 'executed');
  f.git('config', 'filter.synthetic.clean', 'touch ' + marker);
  f.write('.gitattributes', '*.txt filter=synthetic\n');
  await assert.rejects(f.plan(), rejected);
  assert.equal(existsSync(marker), false);
  f.git('config', '--unset', 'filter.synthetic.clean');
  rmSync(join(f.root, '.gitattributes'));
  writeFileSync(join(f.root, '.git/hooks/pre-commit'), '#!/bin/sh\ntouch "' + marker + '"\n', {
    mode: 0o755,
  });
  await assert.rejects(f.plan(), rejected);
  assert.equal(existsSync(marker), false);
  rmSync(join(f.root, '.git/hooks/pre-commit'));
  writeFileSync(join(f.root, '.git/objects/info/alternates'), join(f.temporary, 'private') + '\n');
  await assert.rejects(f.plan(), rejected);
  rmSync(join(f.root, '.git/objects/info/alternates'));
  f.write('selected.txt', Buffer.alloc(GIT_ACTION_LIMITS.fileBytes + 1));
  await assert.rejects(f.plan(), rejected);
});

test('lease loss before dispatch rejects, after object/ref write becomes unknown and read-only recovery never changes the index', async (t) => {
  const f = fixture(t);
  f.write('selected.txt', 'selected\n');
  const plan = await f.plan();
  let current = true,
    calls = 0;
  await assert.rejects(
    commitProject(plan, {
      assertCurrent: () => {
        if (!current) throw new AppError(409, 'scope changed');
      },
      checkpoint: (stage) => {
        if (stage === 'before-commit') current = false;
      },
      onDispatched: () => {
        calls++;
      },
    }),
    rejected,
  );
  assert.equal(calls, 0);
  assert.equal(existsSync(join(f.root, '.git/index.lock')), false);
  assert.equal((await inspectProjectCommit(plan)).status, 'not-applied');
  await assert.rejects(
    commitProject(plan, {
      checkpoint: (stage) => {
        if (stage === 'after-ref') throw new Error('synthetic lost result');
      },
    }),
    unknown,
  );
  assert.equal(f.git('rev-parse', 'HEAD'), plan.oid);
  const originalIndex = readFileSync(join(f.root, '.git/index'));
  assert.equal((await inspectProjectCommit(plan)).status, 'unknown');
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), originalIndex);
  assert.equal(f.git('rev-list', '--count', 'HEAD'), '2');
  await assert.rejects(commitProject(plan), rejected);
});

test('commit honors existing index locks and never removes another process lock', async (t) => {
  const f = fixture(t);
  f.write('selected.txt', 'changed\n');
  const plan = await f.plan();
  writeFileSync(join(f.root, '.git/index.lock'), 'synthetic other writer');
  await assert.rejects(commitProject(plan), rejected);
  assert.equal(readFileSync(join(f.root, '.git/index.lock'), 'utf8'), 'synthetic other writer');
  assert.equal(f.git('rev-parse', 'HEAD'), f.baseline);
});

test('a competing lock after durable dispatch is a settled rejection without original repository writes', async (t) => {
  const f = fixture(t);
  f.write('selected.txt', 'reviewed\n');
  const plan = await f.plan(),
    index = join(f.root, '.git/index'),
    lock = index + '.lock',
    before = readFileSync(index);
  let dispatched = 0;
  await assert.rejects(
    commitProject(plan, {
      onDispatched: () => {
        dispatched++;
        assert.equal(existsSync(lock), false);
        writeFileSync(lock, 'competing writer');
      },
    }),
    rejected,
  );
  assert.equal(dispatched, 1);
  assert.equal(f.git('rev-parse', 'HEAD'), f.baseline);
  assert.deepEqual(readFileSync(index), before);
  assert.equal(readFileSync(lock, 'utf8'), 'competing writer');
  assert.throws(() => f.git('cat-file', '-e', plan.oid));
  assert.equal((await inspectProjectCommit(plan)).status, 'unknown');
  rmSync(lock);
  assert.equal((await inspectProjectCommit(plan)).status, 'not-applied');
});

test('commit inspection never confirms accepted or unapplied outcomes while index or ref locks exist', async (t) => {
  const f = fixture(t);
  f.write('selected.txt', 'reviewed\n');
  const plan = await f.plan();
  const locks = ['index.lock', 'HEAD.lock', 'refs/heads/main.lock', 'packed-refs.lock'];
  for (const status of ['not-applied', 'accepted']) {
    if (status === 'accepted') await commitProject(plan);
    assert.equal((await inspectProjectCommit(plan)).status, status);
    for (const name of locks) {
      const path = join(f.root, '.git', name);
      writeFileSync(path, 'synthetic ongoing writer');
      assert.equal((await inspectProjectCommit(plan)).status, 'unknown', name);
      assert.equal(readFileSync(path, 'utf8'), 'synthetic ongoing writer');
      rmSync(path);
    }
    assert.equal((await inspectProjectCommit(plan)).status, status);
  }
  f.git('checkout', '-qb', 'other');
  assert.equal((await inspectProjectCommit(plan)).status, 'unknown');
});

test('replaced owned index lock cannot overwrite the index and cleanup preserves the replacement', async (t) => {
  const f = fixture(t);
  f.write('selected.txt', 'reviewed\n');
  const plan = await f.plan(),
    index = join(f.root, '.git/index'),
    lock = index + '.lock';
  const original = readFileSync(index);
  await assert.rejects(
    commitProject(plan, {
      checkpoint: (stage) => {
        if (stage !== 'after-ref') return;
        renameSync(lock, join(f.temporary, 'moved-owned-lock'));
        writeFileSync(lock, 'other process lock');
      },
    }),
    unknown,
  );
  assert.equal(f.git('rev-parse', 'HEAD'), plan.oid);
  assert.deepEqual(readFileSync(index), original);
  assert.equal(readFileSync(lock, 'utf8'), 'other process lock');
  assert.equal((await inspectProjectCommit(plan)).status, 'unknown');
});

test('late selected-file changes before dispatch reject and after object writes retain unknown without moving HEAD', async (t) => {
  const f = fixture(t);
  f.write('selected.txt', 'reviewed\n');
  const plan = await f.plan();
  let calls = 0;
  await assert.rejects(
    commitProject(plan, {
      checkpoint: (stage) => {
        if (stage === 'before-commit') f.write('selected.txt', 'changed before dispatch\n');
      },
      onDispatched: () => {
        calls++;
      },
    }),
    rejected,
  );
  assert.equal(calls, 0);
  assert.equal(f.git('rev-parse', 'HEAD'), f.baseline);
  f.write('selected.txt', 'reviewed\n');
  await assert.rejects(
    commitProject(plan, {
      checkpoint: (stage) => {
        if (stage === 'after-objects') f.write('selected.txt', 'changed while preparing\n');
      },
      onDispatched: () => {
        calls++;
      },
    }),
    unknown,
  );
  assert.equal(calls, 1);
  assert.equal(f.git('rev-parse', 'HEAD'), f.baseline);
  assert.equal(readFileSync(join(f.root, 'selected.txt'), 'utf8'), 'changed while preparing\n');
  assert.equal(existsSync(join(f.root, '.git/index.lock')), false);
});

test('smart push creates and fast-forwards exact branches against a real bare receiver with no configured remote', async (t) => {
  const f = fixture(t);
  let dispatched = 0;
  const initial = await f.pushPlan(null);
  await pushProject(initial, {
    token: 'synthetic',
    transport: f.transport,
    onDispatched: () => {
      dispatched++;
    },
  });
  assert.equal(f.raw(f.bare, ['rev-parse', 'refs/heads/main']).toString().trim(), f.baseline);
  assert.equal(
    (await inspectProjectPush(initial, { token: 'synthetic', transport: f.transport })).status,
    'accepted',
  );
  f.write('selected.txt', 'new commit\n');
  const commit = await f.plan();
  await commitProject(commit);
  const forward = await f.pushPlan(f.baseline);
  await pushProject(forward, {
    token: 'synthetic',
    transport: f.transport,
    onDispatched: () => {
      dispatched++;
    },
  });
  assert.equal(f.raw(f.bare, ['rev-parse', 'refs/heads/main']).toString().trim(), commit.oid);
  assert.equal(dispatched, 2);
  assert.equal(f.git('remote'), '');
});

test('remote CAS rejects an intervening writer and read-only retry never repeats receive-pack', async (t) => {
  const f = fixture(t);
  await pushProject(await f.pushPlan(null), { token: 'synthetic', transport: f.transport });
  f.write('selected.txt', 'next\n');
  await commitProject(await f.plan());
  const plan = await f.pushPlan(f.baseline);
  await assert.rejects(
    pushProject(plan, {
      token: 'synthetic',
      transport: f.transport,
      checkpoint: (stage) => {
        if (stage === 'before-push')
          f.raw(f.bare, ['update-ref', 'refs/heads/main', '0'.repeat(40), f.baseline]);
      },
    }),
    unknown,
  );
  assert.equal(f.calls().receives, 2);
  const before = f.calls().receives;
  assert.equal(
    (await inspectProjectPush(plan, { token: 'synthetic', transport: f.transport })).status,
    'unknown',
  );
  assert.equal(f.calls().receives, before);
});

test('non-fast-forward, stale local head and stale expected remote fail before receive', async (t) => {
  const f = fixture(t);
  await pushProject(await f.pushPlan(null), { token: 'synthetic', transport: f.transport });
  f.write('selected.txt', 'remote advance\n');
  await commitProject(await f.plan());
  const remoteHead = f.git('rev-parse', 'HEAD');
  await pushProject(await f.pushPlan(f.baseline), { token: 'synthetic', transport: f.transport });
  const staleLocal = await f.pushPlan(remoteHead);
  f.git('reset', '--hard', f.baseline);
  await assert.rejects(
    pushProject(staleLocal, { token: 'synthetic', transport: f.transport }),
    rejected,
  );
  f.write('selected.txt', 'divergent local\n');
  await commitProject(await f.plan());
  await assert.rejects(
    pushProject(await f.pushPlan(remoteHead), { token: 'synthetic', transport: f.transport }),
    rejected,
  );
  await assert.rejects(
    pushProject(await f.pushPlan(f.baseline), { token: 'synthetic', transport: f.transport }),
    rejected,
  );
  assert.equal(f.calls().receives, 2);
});

test('production transport pins HTTPS GitHub URL and keeps token solely in headers despite hostile inherited Git routing/config', async (t) => {
  const f = fixture(t),
    marker = join(f.temporary, 'credential-executed');
  f.git('config', 'remote.origin.url', 'https://untrusted.invalid/private');
  f.git('config', 'credential.helper', '!touch ' + marker);
  f.git('config', 'url.https://untrusted.invalid/.insteadOf', 'https://github.com/');
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = join(f.temporary, 'not-a-repository');
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  });
  const plan = await f.pushPlan(null),
    requests: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init: init! });
    const receive = url.endsWith('/git-receive-pack');
    const result = receive
      ? await f.transport.receive(Buffer.from(init!.body as Uint8Array))
      : await f.transport.advertise();
    return new Response(new Uint8Array(result), {
      headers: {
        'Content-Type': receive
          ? 'application/x-git-receive-pack-result'
          : 'application/x-git-receive-pack-advertisement',
      },
    });
  };
  await pushProject(plan, { token: 'synthetic_private_push_token', fetch: fetcher });
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      'https://github.com/synthetic/project.git/info/refs?service=git-receive-pack',
      'https://github.com/synthetic/project.git/git-receive-pack',
    ],
  );
  for (const request of requests) {
    assert.equal(request.init.redirect, 'manual');
    assert.equal(
      new Headers(request.init.headers).get('Authorization'),
      'Basic ' + Buffer.from('x-access-token:synthetic_private_push_token').toString('base64'),
    );
    assert.equal(request.url.includes('synthetic_private_push_token'), false);
  }
  assert.equal(existsSync(marker), false);
  assert.equal(
    readFileSync(join(f.root, '.git/config'), 'utf8').includes('synthetic_private_push_token'),
    false,
  );
});

test('post dispatch response loss is unknown and exact remote inspection can confirm without another write', async (t) => {
  const f = fixture(t),
    plan = await f.pushPlan(null);
  const transport: GitPushTransport = {
    advertise: f.transport.advertise,
    async receive(body) {
      await f.transport.receive(body);
      throw new Error('synthetic lost response');
    },
  };
  await assert.rejects(pushProject(plan, { token: 'synthetic', transport }), unknown);
  assert.equal(
    (await inspectProjectPush(plan, { token: 'synthetic', transport })).status,
    'accepted',
  );
  assert.equal(f.calls().receives, 1);
  const redirected: typeof fetch = async () =>
    new Response(null, { status: 302, headers: { Location: 'https://untrusted.invalid' } });
  await assert.rejects(pushProject(plan, { token: 'synthetic', fetch: redirected }), rejected);
});
