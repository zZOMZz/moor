import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectAgentProgram,
  localAgentProgram,
  agentProgramFingerprint,
} from '../src/runtime/agent-program';
import type { AgentConfig } from '../src/runtime/agent';
import { agentSchema } from '../src/protocol';

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

test('bundled diagnostics use the same Node launcher as ACP, with an injected version runner', async (t) => {
  const f = fixture(t),
    config = { ...f.config, runtimeOverrides: undefined },
    calls: unknown[] = [];
  const report = await inspectAgentProgram(
    config,
    f.cwd,
    async (command, args, cwd) => {
      calls.push({ command, args, cwd });
      return 'codex-cli 1.2.3-test.1\n';
    },
    () => 123,
  );
  const program = localAgentProgram(config);
  assert.equal(program.source, 'bundled');
  assert.deepEqual(calls, [
    { command: process.execPath, args: [program.path, '--version'], cwd: f.cwd },
  ]);
  assert.equal(report.version, '1.2.3-test.1');
  assert.equal(report.observedAt, 123);
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
