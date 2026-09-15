import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { RequestError } from '@agentclientprotocol/sdk';
import { createAcpDriver } from '@moor/host/agents/acp/driver';
import type { AgentConfig, AgentCallbacks, AgentRunBinding } from '@moor/host/agents/driver';
import type { AgentForkAnchor } from '@moor/host/agents/fork';
import { AppError } from '@moor/protocol/protocol';

const binding: AgentRunBinding = {
  workspaceId: 'workspace',
  localProjectId: 'project',
  sessionId: 'session',
  expectedTurnId: 'turn',
};
const nativeId = 'native-synthetic';
function fixture(
  t: { after(fn: () => unknown): void },
  variant = 'success',
  agentType = 'codex',
  version?: string,
  custom = false,
) {
  const cwd = mkdtempSync(join(tmpdir(), 'moor-acp-fork-')),
    target = join(cwd, 'target');
  mkdirSync(target);
  const wires: any[] = [],
    children: ChildProcessWithoutNullStreams[] = [];
  let initialized!: () => void;
  const initializeHeld = new Promise<void>((resolve) => {
    initialized = resolve;
  });
  const config: AgentConfig = {
    id: 'synthetic',
    machineId: 'machine',
    name: 'Synthetic',
    cliType: 'builtin',
    agentType,
    ...(custom ? { customAcp: { command: process.execPath, args: [] } } : {}),
    ...(!custom ? { runtimeOverrides: { codexPath: process.execPath } } : {}),
  };
  const driver = createAcpDriver((_command, _args, options) => {
    const child = spawn(
      process.execPath,
      [resolve('tests/fixtures/synthetic-acp-fork.mjs'), 'codex-acp', version ?? '1.11.0', variant],
      { ...options, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] },
    ) as ChildProcessWithoutNullStreams;
    child.on('message', (value: any) => {
      if (value.kind === 'wire') wires.push(value.message);
      if (value.kind === 'initialize-held') initialized();
    });
    children.push(child);
    return child;
  });
  t.after(() => {
    for (const child of children) child.kill();
    rmSync(cwd, { recursive: true, force: true });
  });
  const open = (callbacks: Partial<AgentCallbacks> = {}) =>
    driver.open(config, cwd, nativeId, {
      update: () => {},
      permission: async () => ({ outcome: { outcome: 'cancelled' } }),
      ...callbacks,
    });
  const anchor: AgentForkAnchor = {
    version: 1,
    kind: 'completed-turn',
    adapter: 'codex-acp',
    adapterVersion: '1.11.0',
    sourceNativeId: nativeId,
    messageId: 'exact-native-message',
  };
  return { cwd, target, driver, config, wires, children, initializeHeld, open, anchor };
}
const rejected = (error: unknown) => error instanceof AppError && error.rejected;
const unknown = (error: unknown) => error instanceof AppError && !error.rejected;

test('the Host authority guard rejects before launching and between real ACP initialization and native load or fork', async (t) => {
  const f = fixture(t, 'hold-initialize');
  let current = false;
  const assertCurrent = () => {
    if (!current) throw new AppError(409, 'Synthetic retired encrypted authority');
  };
  const input = {
    sourceNativeId: nativeId,
    sourceCwd: f.cwd,
    targetCwd: f.target,
    assertCurrent,
  };
  await assert.rejects(f.driver.fork!(f.config, input));
  assert.equal(f.children.length, 0);
  current = true;
  const pending = f.driver.fork!(f.config, input);
  await f.initializeHeld;
  current = false;
  f.children[0]!.send!({ kind: 'release-initialize' });
  await assert.rejects(pending, rejected);
  assert.equal(f.children.length, 1);
  assert.deepEqual(
    f.wires.map((wire) => wire.method),
    ['initialize'],
  );
});

test('only pinned advertised native fork capabilities enable supported modes', async (t) => {
  for (const [agent, version, custom, advertised] of [
    ['codex', '1.11.0', false, true],
    ['codex', '1.11.1', false, true],
    ['codex', '1.11.0', false, false],
  ] as const) {
    const f = fixture(t, advertised ? 'success' : 'no-capability', agent, version, custom);
    const session = await f.open();
    try {
      const supported = !custom && advertised && version === '1.11.0';
      assert.equal(session.forkCapabilities?.sameDirectory, supported);
      assert.equal(session.forkCapabilities?.turnCutoff, supported);
      assert.equal(session.forkCapabilities?.worktree, supported);
    } finally {
      await session.close();
    }
  }
});

test('completed-turn anchors come only from live root assistant IDs and completed prompts', async (t) => {
  const f = fixture(t),
    anchors: { anchor: AgentForkAnchor; binding: AgentRunBinding }[] = [];
  const session = await f.open({
    forkAnchor: (anchor, scope) => anchors.push({ anchor, binding: scope }),
  });
  try {
    assert.equal(anchors.length, 0, 'native load replay is not an observed Moor turn');
    for (const scenario of [
      'missing',
      'cancelled',
      'foreign',
      'subagent',
      'tool-after',
      'thought-after',
    ])
      await session.prompt({ prompt: scenario }, binding);
    await assert.rejects(session.prompt({ prompt: 'failed' }, binding));
    await session.prompt({ prompt: 'no-binding' });
    assert.equal(anchors.length, 0);
    await session.prompt({ prompt: 'valid' }, binding);
    assert.deepEqual(anchors, [
      { anchor: { ...f.anchor, messageId: 'native-message-valid' }, binding },
    ]);
  } finally {
    await session.close();
  }
});

test('driver fork loads source passively and sends exact cutoff and target cwd once without a prompt', async (t) => {
  const f = fixture(t);
  assert.deepEqual(
    await f.driver.fork!(f.config, {
      sourceNativeId: nativeId,
      sourceCwd: f.cwd,
      targetCwd: f.target,
      anchor: f.anchor,
    }),
    { nativeId: 'native-child' },
  );
  const requests = f.wires.filter((wire) => wire.method === 'session/fork');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].params, {
    sessionId: nativeId,
    cwd: f.target,
    mcpServers: [],
    _meta: { jetbrains: { air: { fork: { version: 1, messageId: 'exact-native-message' } } } },
  });
  assert.equal(
    f.wires.some((wire) => wire.method === 'session/prompt'),
    false,
  );
  assert.equal(f.wires.find((wire) => wire.method === 'session/load').params.cwd, f.cwd);
});

test('fork without anchor requests only current native context and never fabricates a cutoff', async (t) => {
  const f = fixture(t);
  assert.deepEqual(
    await f.driver.fork!(f.config, {
      sourceNativeId: nativeId,
      sourceCwd: f.cwd,
      targetCwd: f.cwd,
    }),
    { nativeId: 'native-child' },
  );
  const request = f.wires.find((wire) => wire.method === 'session/fork');
  assert.equal(request.params._meta, undefined);
  assert.equal(
    f.wires.some((wire) => wire.method === 'session/prompt'),
    false,
  );
});

test('invalid source anchors and relative cwd reject before any native fork is attempted', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.driver.fork!(f.config, {
      sourceNativeId: nativeId,
      sourceCwd: f.cwd,
      targetCwd: f.target,
      anchor: { ...f.anchor, sourceNativeId: 'foreign' },
    }),
    rejected,
  );
  await assert.rejects(
    f.driver.fork!(f.config, {
      sourceNativeId: nativeId,
      sourceCwd: f.cwd,
      targetCwd: 'relative-directory',
      anchor: f.anchor,
    }),
    rejected,
  );
  assert.equal(
    f.wires.some((wire) => wire.method === 'session/fork'),
    false,
  );
});

test('errors, response loss and reused IDs after native fork remain unknown without any retry', async (t) => {
  for (const variant of ['fork-error', 'exit-after-fork', 'same-id']) {
    const f = fixture(t, variant);
    await assert.rejects(
      f.driver.fork!(f.config, {
        sourceNativeId: nativeId,
        sourceCwd: f.cwd,
        targetCwd: f.target,
        anchor: f.anchor,
      }),
      unknown,
    );
    assert.equal(f.wires.filter((wire) => wire.method === 'session/fork').length, 1);
    assert.equal(
      f.wires.some((wire) => wire.method === 'session/prompt'),
      false,
    );
  }
});

test('host lease is checked before native dispatch and after the known child ID is saved', async (t) => {
  const stale = fixture(t);
  await assert.rejects(
    stale.driver.fork!(stale.config, {
      sourceNativeId: nativeId,
      sourceCwd: stale.cwd,
      targetCwd: stale.target,
      assertCurrent() {
        throw new Error('Synthetic source changed during open');
      },
    }),
    rejected,
  );
  assert.equal(
    stale.wires.some((wire) => wire.method === 'session/fork'),
    false,
  );

  for (const variant of ['success', 'changed-after-native', 'journal-error']) {
    const f = fixture(t, variant),
      known: string[] = [];
    const work = f.driver.fork!(f.config, {
      sourceNativeId: nativeId,
      sourceCwd: f.cwd,
      targetCwd: f.target,
      assertCurrent() {
        if (known.length > 0 && variant === 'changed-after-native')
          throw new Error('Synthetic target changed');
      },
      onNativeId(id) {
        known.push(id);
        if (variant === 'journal-error') throw new Error('Synthetic journal unavailable');
      },
    });
    if (variant === 'success') await work;
    else await assert.rejects(work, unknown);
    assert.deepEqual(known, ['native-child']);
    assert.equal(f.wires.filter((wire) => wire.method === 'session/fork').length, 1);
    assert.equal(
      f.wires.some(
        (wire) => wire.method === 'session/load' && wire.params.sessionId === 'native-child',
      ),
      false,
    );
    const wireText = JSON.stringify(f.wires);
    assert(!wireText.includes('assertCurrent'));
    assert(!wireText.includes('onNativeId'));
  }
});

test('pinned Codex fork implementation maps native message to inclusive turn cutoff and target cwd', async () => {
  const require = createRequire(import.meta.url),
    source = readFileSync(require.resolve('@agentclientprotocol/codex-acp'), 'utf8');
  const start = source.indexOf(
      'async function forkSession(request, additionalDirectories, dependencies) {',
    ),
    end = source.indexOf('// src/CodexAcpClient.ts', start);
  assert(start > 0 && end > start);
  // Execute the exact installed implementation with its native app-server client
  // dependency injected. No copied implementation or real Agent process is used.
  const nativeFork = new Function(
    'RequestError',
    'createHash',
    source.slice(start, end) + '\nreturn forkSession;',
  )(RequestError, createHash);
  const calls: any[] = [];
  const dependencies = {
    refreshSkills: async () => {},
    createSessionConfig: async (cwd: string) => ({ cwd }),
    getResumeModelProvider: async () => 'synthetic',
    fetchAvailableModels: async () => [],
    createCurrentModelId: () => 'synthetic',
    getCollaborationMode: () => 'default',
    codexClient: {
      threadReadWithHistory: async (threadId: string) => ({
        thread: {
          id: threadId,
          turns: [
            { id: 'turn-1', items: [{ id: 'message-1', type: 'agentMessage', text: 'same text' }] },
            { id: 'turn-2', items: [{ id: 'message-2', type: 'agentMessage', text: 'same text' }] },
          ],
        },
      }),
      threadFork: async (input: unknown) => {
        calls.push(input);
        return { thread: { id: 'child' }, model: 'synthetic' };
      },
      threadUnsubscribe: async () => {},
    },
  };
  const result = await nativeFork(
    {
      sessionId: 'source',
      cwd: '/synthetic/target',
      _meta: { jetbrains: { air: { fork: { version: 1, messageId: 'message-1' } } } },
    },
    [],
    dependencies,
  );
  assert.equal(result.sessionId, 'child');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].lastTurnId, 'turn-1');
  assert.equal(calls[0].cwd, '/synthetic/target');
  assert.equal(calls[0].threadId, 'source');
  await assert.rejects(
    nativeFork(
      {
        sessionId: 'source',
        cwd: '/synthetic/target',
        _meta: { jetbrains: { air: { fork: { version: 1, messageId: 'missing-message' } } } },
      },
      [],
      dependencies,
    ),
  );
  assert.equal(calls.length, 1, 'unresolved exact ID must never reach native thread/fork');
});
