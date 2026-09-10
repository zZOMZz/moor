import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { acpDriver } from '../src/runtime/acp';
import type { PermissionOutcome } from '../src/runtime/agent';
const config = {
  id: 'synthetic',
  machineId: 'synthetic',
  name: 'Synthetic',
  cliType: 'custom',
  agentType: 'synthetic',
  customAcp: { command: process.execPath, args: [resolve('scripts/synthetic-agent.mjs')] },
};
test('real stdio ACP handshake streams output, gates permission, completes and reloads native session', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'moor-acp-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const updates: any[] = [];
  let reached!: () => void, respond!: (value: { outcome: PermissionOutcome }) => void;
  const permission = new Promise<void>((r) => (reached = r));
  const session = await acpDriver.open(config, cwd, undefined, {
    update: (value) => updates.push(value),
    permission: async (value) => {
      assert.equal(value.options[0].optionId, 'allow');
      reached();
      return new Promise((r) => (respond = r));
    },
  });
  t.after(session.close);
  const prompt = session.prompt({ prompt: 'synthetic' });
  await permission;
  assert.ok(updates.some((u) => u.sessionUpdate === 'agent_message_chunk'));
  respond({ outcome: { outcome: 'selected', optionId: 'allow' } });
  await prompt;
  assert.ok(updates.some((u) => u.status === 'completed'));
  session.close();
  const resumed = await acpDriver.open(config, cwd, session.id, {
    update: () => assert.fail('session/load history must not become a new reply'),
    permission: async () => ({ outcome: { outcome: 'cancelled' } }),
  });
  assert.equal(resumed.id, session.id);
  resumed.close();
});
test('ACP cancellation resolves an active prompt without a new execution', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'moor-acp-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  let reached!: () => void, respond!: (value: { outcome: PermissionOutcome }) => void;
  const permission = new Promise<void>((r) => (reached = r));
  const session = await acpDriver.open(config, cwd, undefined, {
    update: () => {},
    permission: () => {
      reached();
      return new Promise((r) => (respond = r));
    },
  });
  t.after(session.close);
  const prompt = session.prompt({ prompt: 'synthetic' });
  await permission;
  respond({ outcome: { outcome: 'cancelled' } });
  await session.cancel();
  await prompt;
});
