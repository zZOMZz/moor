import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAcpDriver } from '@moor/host/agents/acp/driver';
import type { AgentSession } from '@moor/host/agents/driver';
import { agentModelFailures } from '@moor/protocol/agent-errors';

async function fixture(
  t: { after(fn: () => unknown): void },
  settings: Record<string, unknown> = {},
  nativeId?: string,
) {
  const cwd = mkdtempSync(join(tmpdir(), 'moor-acp-models-'));
  let child!: ChildProcessWithoutNullStreams,
    session: AgentSession | undefined,
    valid = true;
  let closed: Promise<unknown> | undefined;
  const wires: any[] = [],
    signals: any[] = [],
    observers = new Set<() => void>();
  const driver = createAcpDriver((_command, _args, options) => {
    child = spawn(
      process.execPath,
      [resolve('tests/fixtures/synthetic-acp-models.mjs'), JSON.stringify(settings)],
      { ...options, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] },
    ) as ChildProcessWithoutNullStreams;
    closed = once(child, 'close');
    child.on('message', (message: any) => {
      signals.push(message);
      if (message.kind === 'wire') wires.push(message.message);
      for (const observe of observers) observe();
    });
    return child;
  });
  t.after(async () => {
    if (session) await session.close();
    else if (child?.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    rmSync(cwd, { recursive: true, force: true });
  });
  session = await driver.open(
    {
      id: 'synthetic',
      name: 'Synthetic',
      cliType: 'builtin',
      agentType: 'codex',
      machineId: 'synthetic',
      runtimeOverrides: { codexPath: process.execPath },
    },
    cwd,
    nativeId,
    {
      update() {},
      permission: async () => {
        throw new Error('Probe requested a permission');
      },
    },
    {
      assertCurrent() {
        if (!valid) throw new Error('Synthetic scope expired');
      },
    },
  );
  const waitSignal = (matches: (message: any) => boolean) =>
    Promise.race([
      new Promise<void>((done) => {
        const inspect = () => {
          if (signals.some(matches)) {
            observers.delete(inspect);
            done();
          }
        };
        observers.add(inspect);
        inspect();
      }),
      closed!.then(() => {
        throw new Error('Synthetic ACP exited before signal');
      }),
    ]);
  let barrier = 0;
  return {
    session,
    wires,
    methods: () => wires.map((message) => message.method),
    revoke() {
      valid = false;
    },
    release() {
      child.send('release');
    },
    held: () => waitSignal((message) => message.kind === 'held'),
    drain() {
      const id = ++barrier;
      const waiting = waitSignal((message) => message.kind === 'barrier' && message.id === id);
      child.send({ kind: 'barrier', id });
      return waiting;
    },
  };
}

test('new and loaded sessions report observed current model without inventing a loaded default', async (t) => {
  const fresh = await fixture(t);
  assert.equal(fresh.session.capabilities.currentModelId, 'a');
  assert.equal(fresh.session.capabilities.defaultModelId, 'a');
  assert.equal(fresh.session.capabilities.currentReasoningEffort, 'low');
  const loaded = await fixture(t, {}, 'saved-native-session');
  assert.equal(loaded.session.capabilities.currentModelId, 'a');
  assert.equal(loaded.session.capabilities.sessionKind, 'loaded');
  assert.equal(loaded.session.capabilities.defaultModelId, undefined);
});

test('model probe reads its returned effort choices and never prompts', async (t) => {
  const f = await fixture(t);
  const caps = await f.session.configureModel!('b');
  await f.drain();
  assert.equal(caps.currentModelId, 'b');
  assert.equal(caps.defaultModelId, 'a');
  assert.deepEqual(
    caps.models.map((m) => m.efforts),
    [[], ['high', 'max']],
  );
  assert.equal(f.methods().includes('session/prompt'), false);
  assert.deepEqual(f.session.capabilities, caps);
});

test('sending first changes the model, validates its new efforts, then dispatches exactly once', async (t) => {
  const f = await fixture(t);
  await f.session.prompt({
    prompt: 'Synthetic request',
    modelId: 'b',
    configOptionValues: { effort: 'high' },
  });
  await f.drain();
  assert.deepEqual(f.methods(), [
    'initialize',
    'session/new',
    'session/set_config_option',
    'session/set_config_option',
    'session/prompt',
  ]);
  assert.deepEqual(f.wires[2].params, {
    sessionId: f.session.id,
    configId: 'selected_model',
    value: 'b',
  });
  assert.equal(f.wires[3].params.value, 'high');
});

test('obsolete model, previous model effort and stale config IDs cannot dispatch a prompt', async (t) => {
  for (const input of [
    { modelId: 'missing' },
    { modelId: 'b', configOptionValues: { effort: 'low' } },
    { modelId: 'b', configOptionValues: { previous_effort: 'high' } },
  ]) {
    const f = await fixture(t);
    await assert.rejects(f.session.prompt({ prompt: 'Never send', ...input }), /模型|配置/);
    await f.drain();
    assert.equal(f.methods().includes('session/prompt'), false);
  }
});

test('configuration updates before session creation and during prompts replace observations with session binding', async (t) => {
  const startup = await fixture(t, { startupUpdate: true });
  assert.equal(startup.session.capabilities.currentModelId, 'b');
  assert.equal(startup.session.capabilities.defaultModelId, 'a');
  for (const wrongSession of [false, true]) {
    const f = await fixture(t, { promptUpdate: true, wrongSession });
    await f.session.prompt({ prompt: 'Synthetic request' });
    assert.equal(f.session.capabilities.currentModelId, wrongSession ? 'a' : 'b');
    assert.equal(f.session.capabilities.currentReasoningEffort, wrongSession ? 'low' : 'max');
  }
});

test('removed configuration or a rejected model cannot be presented as a successful selection', async (t) => {
  for (const settings of [{ removeOptions: true }, { rejectSelection: true }]) {
    const f = await fixture(t, settings);
    await assert.rejects(f.session.configureModel!('b'), /模型/);
    await f.drain();
    assert.equal(f.methods().includes('session/prompt'), false);
  }
});

test('a pending configuration probe excludes prompts and checks revoked authority before dispatch', async (t) => {
  const f = await fixture(t, { hold: 'session/set_config_option' });
  const changing = f.session.configureModel!('b');
  const rejected = assert.rejects(changing, /expired/);
  await f.held();
  await assert.rejects(f.session.prompt({ prompt: 'Never send' }), /配置/);
  f.revoke();
  f.release();
  await rejected;
  await f.drain();
  assert.equal(f.methods().includes('session/prompt'), false);
});

test('known upstream model failures expose fixed guidance and never fall back or retry', async (t) => {
  for (const [configError, expected] of [
    [
      "The 'synthetic-model' model requires a newer version of Codex. /synthetic/private token=secret",
      agentModelFailures.programVersion,
    ],
    [
      "The 'synthetic-model' model is not supported when using Codex with a ChatGPT account. token=secret",
      agentModelFailures.accountModel,
    ],
  ]) {
    const f = await fixture(t, { configError });
    await assert.rejects(
      f.session.prompt({ prompt: 'Keep this original input', modelId: 'b' }),
      (error: unknown) => error instanceof Error && error.message === expected,
    );
    await f.drain();
    assert.equal(f.methods().filter((method) => method === 'session/set_config_option').length, 1);
    assert.equal(f.methods().includes('session/prompt'), false);
  }
});
