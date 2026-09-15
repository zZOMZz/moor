import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectAgentProgram,
  localAgentProgram,
  agentProgramFingerprint,
} from '@moor/host/agents/program';
import type { AgentConfig } from '@moor/host/agents/driver';
import { agentSchema } from '@moor/protocol/protocol';

function fixture(t: { after(fn: () => void): void }) {
  const cwd = mkdtempSync(join(tmpdir(), 'moor-program-test-')),
    path = join(cwd, 'synthetic-codex');
  writeFileSync(path, `#!${process.execPath}\nprocess.stdout.write('codex-cli 7.8.9\\n');\n`, {
    mode: 0o700,
  });
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const config: AgentConfig = {
    id: 'synthetic',
    name: 'Synthetic',
    agentType: 'codex',
    cliType: 'builtin',
    machineId: 'synthetic',
    runtimeOverrides: { codexPath: path },
  };
  return { cwd, path, config };
}

test('local diagnostics run only --version on the selected synthetic executable and project no path remotely', async (t) => {
  const f = fixture(t),
    description = localAgentProgram(f.config);
  assert.equal(description.source, 'local');
  assert.equal(description.path, f.path);
  assert.equal(description.adapterName, '@agentclientprotocol/codex-acp');
  assert.match(description.adapterVersion!, /^\d+\.\d+\.\d+/);
  const report = await inspectAgentProgram(f.config, f.cwd);
  assert.equal(report.version, '7.8.9');
  assert.equal(report.versionStatus, 'reported');
  assert.equal(report.fingerprint, description.fingerprint);
  const projected = agentSchema.parse({
    ...f.config,
    program: description,
    checked: { program: report },
  });
  assert.doesNotMatch(JSON.stringify(projected), /path|fingerprint|synthetic-codex|7\.8\.9/);
});

test('pathless built-in Codex diagnostics fail before invoking a version runner', async (t) => {
  const f = fixture(t),
    config = { ...f.config, runtimeOverrides: undefined };
  await assert.rejects(
    inspectAgentProgram(config, f.cwd, async () => {
      assert.fail('must not inspect an unavailable Codex executable');
    }),
    /未找到可用的本机 Codex/,
  );
  assert.throws(() => localAgentProgram(config), /未找到可用的本机 Codex/);
});

test('private or malformed version output remains unknown, and diagnostics reject an in-place upgrade', async (t) => {
  const f = fixture(t);
  for (const output of ['private-token /private/path', 'codex-cli 1.2.3\nprivate-token', '1.2.3']) {
    const report = await inspectAgentProgram(
      f.config,
      f.cwd,
      async () => output,
      () => 1,
    );
    assert.equal(report.versionStatus, 'unavailable');
    assert.equal(report.version, undefined);
    assert.doesNotMatch(JSON.stringify(report), /private/);
  }
  const before = agentProgramFingerprint(f.config);
  await assert.rejects(
    inspectAgentProgram(f.config, f.cwd, async () => {
      writeFileSync(f.path, 'synthetic replacement');
      return 'codex-cli 1.2.3';
    }),
    /程序已变化/,
  );
  assert.notEqual(agentProgramFingerprint(f.config), before);
});

test('custom ACP diagnostics never guess or run a version command with user-supplied arguments', async (t) => {
  const f = fixture(t),
    config = {
      ...f.config,
      cliType: 'custom',
      customAcp: { command: f.path, args: ['private-secret'] },
    };
  const report = await inspectAgentProgram(config, f.cwd, async () => {
    assert.fail('must not execute');
  });
  assert.equal(report.versionStatus, 'not-applicable');
  assert.equal(localAgentProgram(config).source, 'custom');
  assert.doesNotMatch(JSON.stringify(localAgentProgram(config)), /private-secret/);
});
