import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acpDriver, createAcpDriver } from '../src/runtime/acp';
import { LOCAL_CODEX_NOT_INSTALLED } from '../src/runtime/agent';
import { AppError } from '../src/protocol';

test('builtin ACP rejects missing or unsupported local providers before adapter launch', async () => {
  let launches = 0;
  const driver = createAcpDriver(() => {
    launches++;
    throw new Error('must not launch');
  });
  const callbacks = {
    update: () => {},
    permission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
  };
  await assert.rejects(
    driver.open(
      {
        id: 'personal-codex',
        machineId: 'synthetic',
        name: 'Codex',
        cliType: 'builtin',
        agentType: 'codex',
      },
      process.cwd(),
      undefined,
      callbacks,
    ),
    (error: unknown) => error instanceof AppError && error.message === LOCAL_CODEX_NOT_INSTALLED,
  );
  await assert.rejects(
    driver.open(
      {
        id: 'legacy-claude',
        machineId: 'synthetic',
        name: 'Legacy',
        cliType: 'builtin',
        agentType: 'claude',
        runtimeOverrides: { codexPath: process.execPath },
      },
      process.cwd(),
      undefined,
      callbacks,
    ),
    /仅支持本机 Codex/,
  );
  assert.equal(launches, 0);
});

test('real stdio ACP new and native load remove inherited Git routing while preserving configured execution and authentication', async (t) => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'moor-acp-environment-'))),
    source = join(temp, 'source'),
    worktree = join(temp, 'worktree');
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  );
  const git = (...args: string[]) =>
    execFileSync(
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
        source,
        ...args,
      ],
      {
        env: { ...environment, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  mkdirSync(source);
  writeFileSync(join(source, 'file.txt'), 'Synthetic baseline\n');
  git('init', '--initial-branch=main');
  git('add', '.');
  git('commit', '-m', 'Synthetic baseline');
  git('worktree', 'add', '-b', 'moor/synthetic', '--', worktree, 'HEAD');
  const inherited = {
    GIT_DIR: join(source, '.git'),
    GIT_WORK_TREE: source,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.worktree',
    GIT_CONFIG_VALUE_0: source,
    GIT_TRACE: join(temp, 'unexpected-trace'),
    MOOR_SYNTHETIC_AUTH: 'synthetic-auth-kept',
    CODEX_PATH: '/synthetic/inherited-codex',
  };
  const previous = Object.fromEntries(Object.keys(inherited).map((key) => [key, process.env[key]]));
  Object.assign(process.env, inherited);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  let nativeId: string | undefined;
  for (const round of ['new', 'load']) {
    const messages: unknown[] = [];
    const session = await acpDriver.open(
      {
        id: 'synthetic-environment',
        machineId: 'synthetic',
        name: 'Synthetic',
        cliType: 'custom',
        agentType: 'synthetic',
        customAcp: {
          command: process.execPath,
          args: [resolve('tests/support/synthetic-acp-environment.mjs')],
        },
        runtimeOverrides: { codexPath: '/synthetic/configured-codex' },
      },
      worktree,
      nativeId,
      {
        update: (value) => {
          if (value.sessionUpdate === 'agent_message_chunk' && value.content.type === 'text')
            messages.push(JSON.parse(value.content.text));
        },
        permission: async () => ({ outcome: { outcome: 'cancelled' } }),
      },
    );
    try {
      await session.prompt({ prompt: 'Inspect synthetic execution scope' });
      assert.deepEqual(
        messages,
        [
          {
            cwd: worktree,
            requestedCwd: worktree,
            gitTopLevel: worktree,
            gitKeys: [],
            syntheticAuth: 'synthetic-auth-kept',
            codexPath: '/synthetic/configured-codex',
            hasPath: true,
          },
        ],
        round,
      );
      if (nativeId) assert.equal(session.id, nativeId);
      nativeId = session.id;
    } finally {
      await session.close();
    }
  }
});
