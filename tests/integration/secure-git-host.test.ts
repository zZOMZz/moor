import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStore } from '@moor/host/persistence/store';
import { HostWorkspace } from '@moor/host/sessions/workspace';
import {
  gitActionSchema,
  gitOperationSchema,
  gitStateReadSchema,
} from '@moor/protocol/git-protocol';
import { SecureGitController } from '../../apps/web/src/features/git/secure-git';
import { fixture, target } from '../fixtures/secure-git-fixture';

function git(root: string, ...args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgSign=false',
      '-c',
      'user.name=Synthetic',
      '-c',
      'user.email=synthetic@example.invalid',
      '-C',
      root,
      ...args,
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
        ),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  ).trim();
}

test('trusted Git controller uses real Host worktree and durable receipt recovery, preserves dirty source and never starts Agent', async (t) => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'moor-secure-git-host-'))),
    root = join(temp, 'project');
  mkdirSync(root);
  writeFileSync(join(root, 'file.txt'), 'Synthetic committed baseline\n');
  git(root, 'init', '--initial-branch=main');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Synthetic baseline');
  const base = git(root, 'rev-parse', 'main');
  writeFileSync(join(root, 'file.txt'), 'Synthetic unsaved source change\n');
  const runtime = new RuntimeStore(join(temp, 'runtime.sqlite'), {
    worktreeRoot: join(temp, 'private-worktrees'),
  });
  Object.assign(runtime.workspace, {
    id: target.workspaceId,
    userId: target.userId,
    machineId: target.machineId,
  });
  runtime.save('identity', Buffer.from(JSON.stringify(runtime.workspace)));
  runtime.machine.set(['localProject', target.localProjectId], {
    id: target.localProjectId,
    name: 'Synthetic',
    rootPath: root,
  });
  runtime.saveMachine();
  let starts = 0,
    lost = true,
    actions = 0;
  const host = new HostWorkspace(
    runtime,
    {
      async open() {
        starts++;
        throw Error('Directory actions must not start an Agent');
      },
    },
    () => {},
    () => {},
  );
  t.after(() => {
    host.close();
    runtime.close();
    rmSync(temp, { recursive: true, force: true });
  });
  const f = fixture(),
    create = () =>
      new SecureGitController({
        ...f.deps,
        request: async (original, method, params, current) => {
          assert.deepEqual(original, target);
          current();
          if (method === 'git-state')
            return host.readGitState(
              gitStateReadSchema.parse(params),
              target.localProjectId,
              current,
            );
          if (method === 'git-operations')
            return host.gitOperations(
              gitOperationSchema.parse(params),
              target.localProjectId,
              current,
            );
          actions++;
          const receipt = await host.gitAction(
            gitActionSchema.parse(params),
            target.localProjectId,
            current,
          );
          if (lost) throw Error('Synthetic dropped Host receipt');
          return receipt;
        },
      });
  let controller = create();
  await controller.open(target, { newSession: true });
  assert.equal(controller.state!.git.state!.repository.dirty, true);
  assert.equal(controller.state!.git.state!.canPrepare, true);
  await assert.rejects(
    controller.prepare(controller.state!.review, 'main', base, 'feature/secure-synthetic'),
    /dropped/,
  );
  assert(controller.state!.git.pending);
  const original = structuredClone(controller.state!.git.pending);
  controller.close();
  controller = create();
  await controller.open(target, { newSession: true });
  assert.deepEqual(controller.state!.git.pending, original);
  assert.equal(actions, 1);
  lost = false;
  await controller.recover(controller.state!.review, 'inspect');
  assert.equal(controller.state!.git.receipt!.phase, 'accepted');
  assert.equal(actions, 1);
  const execution = runtime.executions.get({
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId: target.sessionId,
    userId: target.userId,
    machineId: target.machineId,
  })!;
  const cwd = execution.managed!.cwd;
  assert.equal(readFileSync(join(cwd, 'file.txt'), 'utf8'), 'Synthetic committed baseline\n');
  assert.equal(readFileSync(join(root, 'file.txt'), 'utf8'), 'Synthetic unsaved source change\n');
  assert.equal(git(root, 'branch', '--show-current'), 'main');
  writeFileSync(join(cwd, 'file.txt'), 'Synthetic uncommitted worktree change\n');
  await assert.rejects(controller.remove(controller.state!.review), /已改变/);
  await controller.refresh(controller.state!.review);
  assert.equal(controller.state!.git.state!.canRemove, false);
  await assert.rejects(controller.remove(controller.state!.review));
  assert.equal(actions, 1);
  assert(existsSync(cwd));
  writeFileSync(join(cwd, 'file.txt'), 'Synthetic committed baseline\n');
  await controller.refresh(controller.state!.review);
  assert.equal(controller.state!.git.state!.canRemove, true);
  await controller.remove(controller.state!.review);
  assert.equal(controller.state!.git.execution!.status, 'removed');
  assert(!existsSync(cwd));
  assert.equal(git(root, 'rev-parse', 'feature/secure-synthetic'), base);
  assert.equal(readFileSync(join(root, 'file.txt'), 'utf8'), 'Synthetic unsaved source change\n');
  assert.equal(actions, 2);
  assert.equal(starts, 0);
});
