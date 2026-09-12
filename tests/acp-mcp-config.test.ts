import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createAcpDriver,
  MCP_AUTHORIZATION_EXPIRED,
  MCP_UNSUPPORTED_TRANSPORT,
} from '../src/runtime/acp';
import type {
  AgentCallbacks,
  AgentMcpServer,
  AgentOpenOptions,
  AgentRunBinding,
} from '../src/runtime/agent';
import { AppError } from '../src/protocol';
import { normalizeAgentContent, normalizeAgentToolContent } from '../src/runtime/agent-attachments';
import type { AttachmentReference } from '../src/content-protocol';

const binding: AgentRunBinding = {
  workspaceId: 'synthetic-workspace',
  localProjectId: 'synthetic-project',
  sessionId: 'synthetic-session',
  expectedTurnId: 'synthetic-turn',
};
const secrets = [
  'synthetic-argument-secret',
  'synthetic-environment-secret',
  'synthetic-header-secret',
  'synthetic-additional-secret',
];
const servers: AgentMcpServer[] = [
  {
    name: 'moor_mcp_mcpv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    command: '/synthetic/private/mcp-program',
    args: [secrets[0]!, ''],
    env: [{ name: 'SYNTHETIC_TOKEN', value: secrets[1]! }],
  },
  {
    type: 'http',
    name: 'moor_mcp_mcpv_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    url: 'https://synthetic.invalid/private-mcp',
    headers: [{ name: 'Authorization', value: 'Bearer ' + secrets[2] }],
  },
  {
    type: 'sse',
    name: 'moor_mcp_mcpv_cccccccccccccccccccccccccccccccc',
    url: 'https://synthetic.invalid/private-events',
    headers: [],
  },
];
function gate<T = void>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve: (value: T) => resolve(value),
  };
}
function fixture(
  t: { after(fn: () => unknown): void },
  settings: Record<string, unknown> = {},
  callbacks: Partial<AgentCallbacks> = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), 'moor-acp-mcp-'));
  const wires: any[] = [],
    signals: any[] = [],
    launches: any[] = [],
    outputs: unknown[] = [];
  const children: { child: ChildProcessWithoutNullStreams; closed: Promise<any> }[] = [];
  const observers = new Set<() => void>();
  let valid = true,
    taskValid = true,
    taskDispatched = 0;
  const mcp: NonNullable<AgentOpenOptions['mcp']> = {
    servers: structuredClone(servers),
    redact: [...secrets],
    assertCurrent() {
      if (!valid) throw new AppError(409, secrets.join(' '));
    },
  };
  const taskTools: NonNullable<AgentOpenOptions['taskTools']> = {
    url: 'http://127.0.0.1:23456/mcp',
    token: randomBytes(32).toString('base64url'),
    assertCurrent() {
      if (!taskValid) throw new Error('private-task-expired');
    },
    onPromptDispatch() {
      taskDispatched++;
    },
  };
  const config = {
    id: 'synthetic',
    name: 'Synthetic',
    machineId: 'synthetic',
    cliType: 'builtin',
    agentType: 'codex',
  };
  const driver = createAcpDriver((command, args, options) => {
    launches.push({ command, args, options });
    const child = spawn(
      process.execPath,
      [resolve('tests/support/synthetic-acp-mcp-config.mjs'), JSON.stringify(settings)],
      { ...options, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] },
    ) as ChildProcessWithoutNullStreams;
    const closed = once(child, 'close');
    children.push({ child, closed });
    child.on('message', (message: any) => {
      signals.push(message);
      if (message.kind === 'wire') wires.push(message.message);
      for (const observer of observers) observer();
    });
    return child;
  });
  t.after(async () => {
    for (const item of children) {
      if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill();
      await item.closed;
    }
    rmSync(cwd, { recursive: true, force: true });
  });
  const handlers: AgentCallbacks = {
    update: (value) => outputs.push(value),
    event: (event, scope) => outputs.push({ event, scope }),
    permission: async (value) => {
      outputs.push(value);
      return { outcome: { outcome: 'selected', optionId: 'allow' } };
    },
    question: async (request) => {
      outputs.push(request);
      return {
        ...binding,
        interactionVersion: 1,
        requestId: request.requestId,
        operationId: 'synthetic-answer',
        answer: { action: 'decline' },
      };
    },
    ...callbacks,
  };
  const wait = (predicate: (signal: any) => boolean) =>
    new Promise<any>((done, reject) => {
      const inspect = () => {
        const found = signals.find(predicate);
        if (found) {
          observers.delete(inspect);
          done(found);
        }
      };
      observers.add(inspect);
      inspect();
      void children.at(-1)?.closed.then(() => {
        if (observers.delete(inspect))
          reject(new Error('Synthetic ACP closed before expected signal'));
      });
    });
  return {
    driver,
    config,
    cwd,
    mcp,
    taskTools,
    launches,
    wires,
    outputs,
    signals,
    children,
    handlers,
    open: async (nativeId?: string, options: AgentOpenOptions | undefined = { mcp }) => {
      const session = await driver.open(config, cwd, nativeId, handlers, options);
      // IPC observations and ACP stdout use separate streams; wait for the
      // concrete request observation instead of assuming their arrival order.
      await wait(
        (signal) =>
          signal.kind === 'wire' &&
          signal.message.method === (nativeId ? 'session/load' : 'session/new'),
      );
      return session;
    },
    wait,
    waitMethod: (method: string) =>
      wait((signal) => signal.kind === 'wire' && signal.message.method === method),
    revoke: () => {
      valid = false;
    },
    revokeTask: () => {
      taskValid = false;
    },
    taskDispatched: () => taskDispatched,
  };
}

test('ACP new/load carry the complete fixed private stdio/http/sse descriptions alongside separately authorized task tools', async (t) => {
  for (const nativeId of [undefined, 'synthetic-existing']) {
    const f = fixture(t);
    const session = await f.open(nativeId, { mcp: f.mcp, taskTools: f.taskTools });
    try {
      const request = f.wires.find(
        (wire) => wire.method === (nativeId ? 'session/load' : 'session/new'),
      );
      assert.deepEqual(request.params.mcpServers, [
        {
          type: 'http',
          name: 'moor_tasks',
          url: f.taskTools.url,
          headers: [{ name: 'Authorization', value: 'Bearer ' + f.taskTools.token }],
        },
        ...servers,
      ]);
      assert.equal('type' in request.params.mcpServers[1], false);
      assert.equal(f.launches[0].options.env.DISABLE_MCP_CONFIG_FILTERING, 'true');
      for (const secret of secrets) assert.ok(!JSON.stringify(f.launches).includes(secret));
      assert.equal(f.taskDispatched(), 0);
      await session.prompt({ prompt: 'Synthetic task' }, binding);
      assert.equal(f.taskDispatched(), 1);
      await assert.rejects(
        session.fork!({ sourceNativeId: session.id, sourceCwd: f.cwd, targetCwd: f.cwd }),
        /MCP 授权/,
      );
      assert.equal(
        f.wires.some((wire) => wire.method === 'session/fork'),
        false,
      );
    } finally {
      await session.close();
    }
  }
});

test('plain opens, capability probes and native Fork never acquire caller-selected extra MCP or override native configuration policy', async (t) => {
  const f = fixture(t);
  const session = await f.open(undefined, {});
  await session.close();
  assert.deepEqual(f.wires.find((wire) => wire.method === 'session/new').params.mcpServers, []);
  assert.equal(
    f.launches[0].options.env.DISABLE_MCP_CONFIG_FILTERING,
    process.env.DISABLE_MCP_CONFIG_FILTERING,
  );
  const forked = await f.driver.fork!(f.config, {
    sourceNativeId: 'synthetic-original',
    sourceCwd: f.cwd,
    targetCwd: f.cwd,
  });
  assert.equal(forked.nativeId, 'synthetic-fork-child');
  for (const wire of f.wires.filter((wire) =>
    ['session/new', 'session/load'].includes(wire.method),
  ))
    assert.deepEqual(wire.params.mcpServers, []);
  for (const launch of f.launches)
    assert.equal(
      launch.options.env.DISABLE_MCP_CONFIG_FILTERING,
      process.env.DISABLE_MCP_CONFIG_FILTERING,
    );
  const task = fixture(t);
  const parent = await task.open(undefined, { taskTools: task.taskTools });
  assert.equal(task.launches[0].options.env.DISABLE_MCP_CONFIG_FILTERING, 'true');
  assert.equal(
    task.wires.find((wire) => wire.method === 'session/new').params.mcpServers.length,
    1,
  );
  await parent.close();
  const custom = fixture(t);
  const opened = await custom.driver.open(
    { ...custom.config, customAcp: { command: process.execPath, args: [] } },
    custom.cwd,
    undefined,
    custom.handlers,
    { mcp: custom.mcp },
  );
  await opened.close();
  assert.equal(
    custom.launches[0].options.env.DISABLE_MCP_CONFIG_FILTERING,
    process.env.DISABLE_MCP_CONFIG_FILTERING,
  );
});

test('invalid private descriptions, duplicate names and the reserved task name are rejected before any process starts', async (t) => {
  for (const invalid of [
    [{ ...servers[0], type: 'stdio' }],
    [{ ...servers[0], name: 'arbitrary-native-server' }],
    [{ ...servers[0], name: 'moor_mcp_arbitrary-native-server' }],
    [{ ...servers[0], name: 'moor_tasks' }],
    [servers[0], servers[0]],
    [{ ...servers[0], command: 'relative' }],
    [{ ...servers[0], command: '/synthetic\0file' }],
    [{ ...servers[1], headers: [{ name: 'Authorization', value: 'bad\r\nvalue' }] }],
    [{ ...servers[1], url: 'file:///synthetic' }],
    [{ ...servers[1], rawProxy: true }],
    Array.from({ length: 9 }, (_, index) => ({ ...servers[0], name: 'moor_mcp_slot_' + index })),
  ]) {
    const f = fixture(t);
    f.mcp.servers = invalid as AgentMcpServer[];
    await assert.rejects(f.open(), /MCP 配置不可验证/);
    assert.equal(f.launches.length, 0);
  }
});

test('HTTP and SSE require the corresponding actual initialization capability; stdio remains protocol baseline', async (t) => {
  for (const capabilities of [
    {},
    { http: false, sse: false },
    { http: true, sse: false },
    { http: false, sse: true },
  ]) {
    for (const nativeId of [undefined, 'existing']) {
      const f = fixture(t, { capabilities });
      await assert.rejects(
        f.open(nativeId),
        (error: Error) => error.message === MCP_UNSUPPORTED_TRANSPORT,
      );
      assert.deepEqual(
        f.wires.map((wire) => wire.method),
        ['initialize'],
      );
    }
  }
  const f = fixture(t, { capabilities: {} });
  f.mcp.servers = [servers[0]!];
  const opened = await f.open();
  await opened.close();
});

test(
  'revocation is checked before launch, across initialize/new/load, and across model/mode changes before prompt',
  { timeout: 15000 },
  async (t) => {
    const early = fixture(t);
    early.revoke();
    await assert.rejects(
      early.open(),
      (error: Error) => error.message === MCP_AUTHORIZATION_EXPIRED,
    );
    assert.equal(early.launches.length, 0);
    for (const held of ['initialize', 'session/new', 'session/load']) {
      const f = fixture(t, { held });
      const opening = f.open(held === 'session/load' ? 'existing' : undefined);
      const rejected = assert.rejects(
        opening,
        (error: Error) => error.message === MCP_AUTHORIZATION_EXPIRED,
      );
      await f.waitMethod(held);
      f.revoke();
      f.children[0]!.child.send!('release');
      await rejected;
      assert.equal(
        f.wires.some((wire) => wire.method === 'session/prompt'),
        false,
      );
    }
    for (const [held, input] of [
      ['session/set_config_option', { modelId: 'model' }],
      ['session/set_mode', { modeId: 'mode' }],
    ] as const) {
      const f = fixture(t, { held });
      const opened = await f.open();
      try {
        const prompt = opened.prompt({ prompt: 'Synthetic', ...input }, binding);
        const rejected = assert.rejects(
          prompt,
          (error: Error) => error.message === MCP_AUTHORIZATION_EXPIRED,
        );
        await f.waitMethod(held);
        f.revoke();
        f.children[0]!.child.send!('release');
        await rejected;
        assert.equal(
          f.wires.some((wire) => wire.method === 'session/prompt'),
          false,
        );
      } finally {
        await opened.close();
      }
    }
  },
);

test('snapshot descriptions are not changed while opening, and either task or MCP revocation blocks the final prompt', async (t) => {
  const f = fixture(t, { held: 'initialize' });
  const opening = f.open();
  await f.waitMethod('initialize');
  f.mcp.servers[0] = { ...servers[0]!, args: ['changed-after-open'] } as AgentMcpServer;
  f.children[0]!.child.send!('release');
  const opened = await opening;
  assert.deepEqual(
    f.wires.find((wire) => wire.method === 'session/new').params.mcpServers,
    servers,
  );
  f.revoke();
  await assert.rejects(
    opened.prompt({ prompt: 'Synthetic' }, binding),
    (error: Error) => error.message === MCP_AUTHORIZATION_EXPIRED,
  );
  await opened.close();
  const task = fixture(t);
  const parent = await task.open(undefined, { mcp: task.mcp, taskTools: task.taskTools });
  task.revokeTask();
  await assert.rejects(parent.prompt({ prompt: 'Synthetic' }, binding), /授权已失效/);
  assert.equal(task.taskDispatched(), 0);
  assert.equal(
    task.wires.some((wire) => wire.method === 'session/prompt'),
    false,
  );
  await parent.close();
});

test(
  'every shared output and interactive description redacts private values; unsafe rewritten choice identities cannot be approved',
  { timeout: 15000 },
  async (t) => {
    for (const scenario of ['echo', 'private-identifiers']) {
      const f = fixture(t, { scenario, extraEcho: secrets[3], echoCapabilities: true });
      const opened = await f.open(undefined, { mcp: f.mcp, taskTools: f.taskTools });
      try {
        await opened.prompt({ prompt: 'Synthetic' }, binding);
        const output = JSON.stringify([f.outputs, opened.currentEvents, opened.capabilities]);
        for (const secret of [
          ...secrets,
          ...servers.map((server) => ('url' in server ? server.url : server.command)),
          f.taskTools.url,
          f.taskTools.token,
        ])
          assert.ok(!output.includes(secret), 'Private description leaked into shared output');
        assert.match(output, /已隐藏 MCP 配置/);
        const permission = await f.wait((signal) => signal.kind === 'permission-result');
        const question = await f.wait((signal) => signal.kind === 'question-result');
        assert.equal(
          permission.value.result.outcome.outcome,
          scenario === 'echo' ? 'selected' : 'cancelled',
        );
        assert.equal(question.value.result.action, scenario === 'echo' ? 'decline' : 'cancel');
        assert.equal(
          f.outputs.filter((value: any) => Array.isArray(value.fields)).length,
          scenario === 'echo' ? 1 : 0,
        );
      } finally {
        await opened.close();
      }
    }
  },
);

test(
  'open/prompt/configuration and host callback failures never expose private diagnostics, including AppError messages',
  { timeout: 15000 },
  async (t) => {
    for (const scenario of [
      'open-error',
      'prompt-error',
      'config-error',
      'echo',
      'question-error',
    ]) {
      const f = fixture(
        t,
        { scenario: scenario === 'question-error' ? 'echo' : scenario },
        scenario === 'echo'
          ? {
              permission: async () => {
                throw new AppError(409, secrets.join(' '));
              },
            }
          : scenario === 'question-error'
            ? {
                question: async () => {
                  throw new AppError(409, secrets.join(' '));
                },
              }
            : {},
      );
      const safe = (error: Error) => {
        for (const secret of secrets) assert.ok(!error.message.includes(secret));
        assert.ok(!error.message.includes('synthetic.invalid'));
        return true;
      };
      if (scenario === 'open-error') await assert.rejects(f.open(), safe);
      else {
        const opened = await f.open();
        try {
          if (scenario === 'echo' || scenario === 'question-error') {
            await opened.prompt({ prompt: 'Synthetic' }, binding);
            const response = await f.wait(
              (signal) =>
                signal.kind === (scenario === 'echo' ? 'permission-result' : 'question-result'),
            );
            for (const secret of secrets)
              assert.ok(!JSON.stringify(response.value).includes(secret));
            assert.ok(response.value.error);
          } else
            await assert.rejects(
              opened.prompt(
                {
                  prompt: 'Synthetic',
                  ...(scenario === 'config-error' ? { modelId: 'model' } : {}),
                },
                binding,
              ),
              safe,
            );
        } finally {
          await opened.close();
        }
      }
    }
  },
);

test(
  'revocation during approval suppresses its late choice and stops only the owned ACP process',
  { timeout: 15000 },
  async (t) => {
    const entered = gate(),
      answer = gate<void>();
    const f = fixture(
      t,
      { scenario: 'permission-hold' },
      {
        permission: async () => {
          entered.resolve();
          await answer.promise;
          return { outcome: { outcome: 'selected', optionId: 'allow' } };
        },
      },
    );
    const opened = await f.open();
    const pending = opened.prompt({ prompt: 'Synthetic' }, binding);
    const rejected = assert.rejects(
      pending,
      (error: Error) => error.message === MCP_AUTHORIZATION_EXPIRED,
    );
    await entered.promise;
    f.revoke();
    answer.resolve();
    await rejected;
    await opened.close();
    assert.ok(
      !f.wires.some(
        (wire) =>
          wire.id === 'synthetic-permission' && wire.result?.outcome?.outcome === 'selected',
      ),
    );
  },
);

test('serialized diagnostics redact escaped private values and explicit cancellation remains available after revocation', async (t) => {
  const echo = fixture(t, { scenario: 'echo' });
  const escaped = 'synthetic-\n"quoted"\\configuration';
  (echo.mcp.servers[0] as Extract<AgentMcpServer, { command: string }>).env.push({
    name: 'ESCAPED_VALUE',
    value: escaped,
  });
  const session = await echo.open();
  try {
    await session.prompt({ prompt: 'Synthetic' }, binding);
    const message = echo.outputs.find(
      (value: any) => value.sessionUpdate === 'agent_message_chunk',
    ) as any;
    assert.ok(message?.content?.text.includes('已隐藏 MCP 配置'));
    assert.ok(!message.content.text.includes(escaped));
    assert.ok(!message.content.text.includes(JSON.stringify(escaped).slice(1, -1)));
  } finally {
    await session.close();
  }

  const f = fixture(t, { scenario: 'hold-prompt' });
  const opened = await f.open();
  const pending = opened.prompt({ prompt: 'Synthetic' }, binding);
  const rejected = assert.rejects(
    pending,
    (error: Error) => error.message === MCP_AUTHORIZATION_EXPIRED,
  );
  await f.waitMethod('session/prompt');
  f.revoke();
  await opened.cancel();
  await f.waitMethod('session/cancel');
  await rejected;
  await opened.close();
});

test('embedded resource blobs and binary image/audio data containing MCP values never reach generated attachment storage', async (t) => {
  const saved: Buffer[] = [],
    normalized: unknown[] = [];
  const save = (reference: AttachmentReference, bytes: Buffer) => {
    saved.push(bytes);
    return reference;
  };
  const f = fixture(
    t,
    { scenario: 'attachment-echo', extraEcho: secrets[3] },
    {
      update: (value) => {
        if (value.sessionUpdate === 'agent_message_chunk')
          normalized.push(normalizeAgentContent(value.content, save));
        else if (value.sessionUpdate === 'tool_call')
          normalized.push(...normalizeAgentToolContent(value.content, save));
      },
    },
  );
  const opened = await f.open(undefined, { mcp: f.mcp, taskTools: f.taskTools });
  try {
    await opened.prompt({ prompt: 'Synthetic' }, binding);
    assert.equal(normalized.length, 8);
    assert.equal(saved.length, 2);
    assert.ok(saved.every((bytes) => bytes.toString('utf8') === 'Synthetic clean artifact'));
    assert.equal(
      JSON.stringify(normalized).match(/Agent 附件包含 MCP 私有配置，未保存/g)?.length,
      6,
    );
    for (const value of [...secrets, f.taskTools.token, f.taskTools.url])
      assert.ok(!JSON.stringify(normalized).includes(value));
  } finally {
    await opened.close();
  }
});

test('native session identifiers containing private MCP values are rejected instead of persisted or projected', async (t) => {
  for (const nativeId of [undefined, secrets[1]]) {
    const f = fixture(t, { nativeId: secrets[0] });
    await assert.rejects(f.open(nativeId), (error: Error) => {
      assert.ok(!secrets.some((secret) => error.message.includes(secret)));
      return true;
    });
    assert.equal(
      f.wires.some((wire) => wire.method === 'session/prompt'),
      false,
    );
  }
});
