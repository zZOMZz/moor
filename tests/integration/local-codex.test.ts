import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { localCodexPath, withLocalCodex } from '@moor/host/agents/acp/local-codex';

test('host resolves installed Codex without running a shell or consulting remote inputs', () => {
  assert.equal(
    localCodexPath({}, () => true),
    join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'),
  );
  assert.equal(
    localCodexPath({}, (p) => p === '/opt/homebrew/bin/codex'),
    '/opt/homebrew/bin/codex',
  );
  assert.equal(
    localCodexPath({}, () => false),
    undefined,
  );
  assert.equal(
    localCodexPath({ MOOR_CODEX_PATH: '/synthetic/codex' }, () => true),
    '/synthetic/codex',
  );
  assert.equal(
    localCodexPath(
      { PATH: ['/relative', '/synthetic/bin', 'relative'].join(delimiter) },
      (path) =>
        path === join('/synthetic/bin', process.platform === 'win32' ? 'codex.exe' : 'codex'),
    ),
    join('/synthetic/bin', process.platform === 'win32' ? 'codex.exe' : 'codex'),
  );
  assert.throws(() => localCodexPath({ MOOR_CODEX_PATH: 'codex' }, () => true));
  assert.throws(() => localCodexPath({ MOOR_CODEX_PATH: '/missing' }, () => false));
  assert.equal(
    localCodexPath(
      { PATH: 'relative::/synthetic/cli:/synthetic/other' },
      (path) => path === '/synthetic/cli/codex',
    ),
    '/synthetic/cli/codex',
  );
  assert.equal(
    localCodexPath({ PATH: 'relative:.' }, () => true),
    join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'),
  );
});

test(
  'macOS discovers ChatGPT before legacy Codex and Homebrew while respecting explicit paths',
  {
    skip: process.platform !== 'darwin',
  },
  () => {
    const current = '/Applications/ChatGPT.app/Contents/Resources/codex',
      legacy = '/Applications/Codex.app/Contents/Resources/codex',
      brew = '/opt/homebrew/bin/codex',
      local = join(homedir(), '.local', 'bin', 'codex');
    assert.equal(
      localCodexPath({}, (path) => [current, legacy, brew].includes(path)),
      current,
    );
    assert.equal(
      localCodexPath({}, (path) => [legacy, brew].includes(path)),
      legacy,
    );
    assert.equal(
      localCodexPath({}, (path) => [local, current, brew].includes(path)),
      local,
    );
    assert.equal(
      localCodexPath({ MOOR_CODEX_PATH: brew }, (path) => [current, brew].includes(path)),
      brew,
    );
  },
);

test('existing personal agent gains local runtime override without changing identity or manual overrides', () => {
  const config = { id: 'personal-codex', agentType: 'codex', env: {}, name: 'Codex' };
  const updated = withLocalCodex(config, '/synthetic/codex');
  assert.deepEqual(updated, { ...config, runtimeOverrides: { codexPath: '/synthetic/codex' } });
  assert.equal(withLocalCodex(updated, '/another/codex'), updated);
  assert.equal(withLocalCodex(config, undefined), config);
  const custom = { ...config, agentType: 'custom' };
  assert.equal(withLocalCodex(custom, '/synthetic/codex'), custom);
});
