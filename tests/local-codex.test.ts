import test from 'node:test';
import assert from 'node:assert/strict';
import { localCodexPath, withLocalCodex } from '../src/bridge/local-codex';

test('host resolves installed Codex without running a shell or consulting remote inputs', () => {
  assert.equal(
    localCodexPath({}, () => true),
    '/Applications/Codex.app/Contents/Resources/codex',
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
  assert.throws(() => localCodexPath({ MOOR_CODEX_PATH: 'codex' }, () => true));
  assert.throws(() => localCodexPath({ MOOR_CODEX_PATH: '/missing' }, () => false));
});

test('existing personal agent gains local runtime override without changing identity or manual overrides', () => {
  const config = { id: 'personal-codex', agentType: 'codex', env: {}, name: 'Codex' };
  const updated = withLocalCodex(config, '/synthetic/codex');
  assert.deepEqual(updated, { ...config, runtimeOverrides: { codexPath: '/synthetic/codex' } });
  assert.equal(withLocalCodex(updated, '/another/codex'), updated);
  assert.equal(withLocalCodex(config, undefined), config);
  const claude = { ...config, agentType: 'claude' };
  assert.equal(withLocalCodex(claude, '/synthetic/codex'), claude);
});
