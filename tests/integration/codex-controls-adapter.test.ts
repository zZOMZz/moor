import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as nodeModule from 'node:module';
import { pathToFileURL } from 'node:url';
import { createAcpDriver } from '@moor/host/agents/acp/driver';
import { readAcpUsage } from '@moor/host/agents/acp/usage';
import { projectAccountUsage } from '@moor/protocol/agent-usage';

function fixture(t: { after(fn: () => unknown): void }) {
  const cwd = mkdtempSync(join(tmpdir(), 'moor-native-controls-')),
    program = join(cwd, 'codex'),
    log = join(cwd, 'wire');
  writeFileSync(
    program,
    '#!' +
      process.execPath +
      '\n' +
      readFileSync(resolve('tests/fixtures/synthetic-codex-app-server.mjs')),
    { mode: 0o700 },
  );
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const config = {
    id: 'synthetic',
    name: 'Synthetic',
    machineId: 'synthetic',
    cliType: 'builtin',
    agentType: 'codex',
    runtimeOverrides: { codexPath: program },
  };
  const launch: typeof spawn = ((cmd: any, args: any, options: any) =>
    spawn(cmd, args, {
      ...options,
      env: { ...options.env, MOOR_SYNTHETIC_LOG: log },
    })) as typeof spawn;
  return {
    cwd,
    config,
    launch,
    messages: () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
  };
}

test('patched locked adapter reads quota without creating a thread or prompting', async (t) => {
  const f = fixture(t);
  const usage = await readAcpUsage(f.config, f.cwd, () => {}, f.launch);
  assert.equal(usage.status, 'ready');
  assert.match(usage.accountKey!, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(usage), /email|example.invalid/);
  assert.equal(projectAccountUsage(usage, 123).buckets[0]?.primary?.usedPercent, 28);
  assert.equal(
    f.messages().some((m) => m.method === 'thread/start' || m.method === 'turn/start'),
    false,
  );
});

test('patched adapter exposes every model effort and sends the exact four permission policies', async (t) => {
  const f = fixture(t),
    updates: any[] = [];
  const driver = createAcpDriver(
    (command, args, options) =>
      f.launch(command, args, {
        ...options,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams,
  );
  const session = await driver.open(f.config, f.cwd, undefined, {
    update() {},
    permission: async () => ({ outcome: { outcome: 'cancelled' } }),
    usage: (update) => updates.push(update),
  });
  t.after(() => session.close());
  assert.deepEqual(
    session.capabilities.models.map((m) => [m.id, m.efforts, m.defaultEffort]),
    [
      ['a', ['low'], 'low'],
      ['b', ['high', 'max'], 'high'],
    ],
  );
  for (const modeId of [
    'moor-read-only',
    'moor-agent',
    'moor-auto-review',
    'moor-full-access',
    'read-only',
    'agent',
  ])
    await session.prompt({ prompt: 'Synthetic', modeId });
  assert.deepEqual(
    f
      .messages()
      .filter((m) => m.method === 'turn/start' && m.params.sandboxPolicy)
      .map((m) => [
        m.params.sandboxPolicy.type,
        m.params.approvalPolicy,
        m.params.approvalsReviewer,
      ]),
    [
      ['readOnly', 'on-request', 'user'],
      ['workspaceWrite', 'on-request', 'user'],
      ['workspaceWrite', 'on-request', 'auto_review'],
      ['dangerFullAccess', 'never', 'user'],
      ['workspaceWrite', 'on-request', 'user'],
      ['workspaceWrite', 'on-request', 'auto_review'],
    ],
  );
  assert.equal(session.currentEvents?.contextUsage?.used, 410);
  assert.ok(updates.some((u) => u.partial && u.rateLimits.primary.usedPercent === 29));
});

test('adapter account changes invalidate old telemetry and reject a late read', async () => {
  const entry = nodeModule.createRequire(import.meta.url).resolve('@agentclientprotocol/codex-acp');
  const { MoorRateLimits } = await import(pathToFileURL(join(dirname(entry), 'moor.js')).href);
  let account: any = { type: 'chatgpt', email: 'first@example.invalid' };
  let listener!: (event: any) => void;
  let rates: () => Promise<unknown> = async () => ({
    rateLimits: { primary: { usedPercent: 25 } },
  });
  const published: any[] = [];
  let ready!: () => void;
  const pushed = new Promise<void>((yes) => {
    ready = yes;
  });
  const extension = new MoorRateLimits({
    codexAcpClient: {
      appServerClient: {
        onClientTransportEvent(fn: typeof listener) {
          listener = fn;
        },
      },
      async getAccount() {
        return { account };
      },
      getRateLimits: () => rates(),
    },
    runWithProcessCheck: (fn: () => Promise<unknown>) => fn(),
    connection: {
      async notify(_method: string, value: any) {
        published.push(value);
        if (value.status === 'ready') ready();
      },
    },
  });
  await assert.rejects(extension.read(), /not negotiated/);
  extension.supported = true;
  const first = await extension.read();
  account = { type: 'chatgpt', email: 'second@example.invalid' };
  const second = await extension.read();
  assert.notEqual(first.accountKey, second.accountKey);
  assert.equal(
    second.status,
    'ready',
    'a change observed by account/read completes in the same query',
  );
  let started!: () => void, release!: (result: unknown) => void;
  const reading = new Promise<void>((yes) => {
    started = yes;
  });
  rates = () => {
    started();
    return new Promise((yes) => {
      release = yes;
    });
  };
  const old = extension.read();
  await reading;
  account = { type: 'chatgpt', email: 'third@example.invalid' };
  rates = async () => ({ rateLimits: { primary: { usedPercent: 7 } } });
  listener({ eventType: 'notification', method: 'account/updated' });
  await pushed;
  release({ rateLimits: { primary: { usedPercent: 90 } } });
  await assert.rejects(old, /Account changed/);
  assert.equal(published.at(-1).rateLimits.primary.usedPercent, 7);
  assert.ok(published.some((value) => value.status === 'unknown'));
  assert.doesNotMatch(JSON.stringify(published), /example.invalid/);
  account = null;
  assert.equal((await extension.read()).status, 'signed-out');
  account = { type: 'apiKey' };
  assert.equal((await extension.read()).status, 'unsupported');
});
