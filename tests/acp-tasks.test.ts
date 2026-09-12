import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createAcpDriver } from '../src/runtime/acp';
import { createTaskMcp } from '../src/runtime/task-mcp';
import type { AgentOpenOptions } from '../src/runtime/agent';

function fixture(
  t: { after(fn: () => unknown): void },
  capability = 'true',
  held = '',
  scenario = 'success',
) {
  const cwd = mkdtempSync(join(tmpdir(), 'moor-acp-tasks-')),
    wires: any[] = [],
    updates: any[] = [],
    children: ChildProcessWithoutNullStreams[] = [];
  const waiters = new Map<string, (value: any) => void>();
  let valid = true,
    dispatched = 0;
  const taskTools: NonNullable<AgentOpenOptions['taskTools']> = {
    url: 'http://127.0.0.1:23456/mcp',
    token: randomBytes(32).toString('base64url'),
    assertCurrent: () => {
      if (!valid) throw new Error('private-invalid-token');
    },
    onPromptDispatch: () => {
      dispatched++;
    },
  };
  const config = {
    id: 'synthetic',
    name: 'Synthetic',
    cliType: 'builtin',
    agentType: 'codex',
    machineId: 'machine',
  };
  const launches: any[] = [];
  const driver = createAcpDriver((command, args, options) => {
    launches.push({ command, args, options });
    const child = spawn(
      process.execPath,
      [resolve('tests/support/synthetic-acp-tasks.mjs'), capability, held, scenario],
      { ...options, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] },
    ) as ChildProcessWithoutNullStreams;
    child.on('message', (value: any) => {
      if (value.kind === 'wire') {
        wires.push(value.message);
        waiters.get(value.message.method)?.(value.message);
      }
    });
    children.push(child);
    return child;
  });
  t.after(() => {
    for (const child of children) child.kill();
    rmSync(cwd, { recursive: true, force: true });
  });
  const callbacks = {
    update: (value: any) => updates.push(value),
    permission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
  };
  const open = (nativeId?: string, tools: typeof taskTools | undefined = taskTools) =>
    driver.open(config, cwd, nativeId, callbacks, tools ? { taskTools: tools } : undefined);
  const wait = (method: string) => {
    const wire = wires.find((item) => item.method === method);
    return wire ? Promise.resolve(wire) : new Promise<any>((r) => waiters.set(method, r));
  };
  return {
    taskTools,
    driver,
    config,
    cwd,
    callbacks,
    launches,
    wires,
    updates,
    children,
    open,
    wait,
    revoke: () => {
      valid = false;
    },
    dispatched: () => dispatched,
  };
}

test('ACP requires explicit HTTP MCP capability before new or load and kills unsupported peers', async (t) => {
  for (const capability of ['false', 'missing'])
    for (const nativeId of [undefined, 'existing']) {
      const f = fixture(t, capability);
      await assert.rejects(f.open(nativeId), /不支持 HTTP MCP/);
      assert.deepEqual(
        f.wires.map((wire) => wire.method),
        ['initialize'],
      );
      assert.equal(f.dispatched(), 0);
      assert.ok(f.children[0]!.signalCode || f.children[0]!.exitCode !== null);
    }
});

test('ACP new and load receive only the ephemeral HTTP descriptor, never launch arguments or config', async (t) => {
  for (const nativeId of [undefined, 'existing']) {
    const f = fixture(t),
      session = await f.open(nativeId);
    try {
      const params = f.wires.find(
        (wire) => wire.method === (nativeId ? 'session/load' : 'session/new'),
      ).params;
      assert.deepEqual(params.mcpServers, [
        {
          type: 'http',
          name: 'moor_tasks',
          url: f.taskTools.url,
          headers: [{ name: 'Authorization', value: 'Bearer ' + f.taskTools.token }],
        },
      ]);
      assert.doesNotMatch(
        JSON.stringify([f.launches, f.config, session.capabilities]),
        new RegExp(f.taskTools.token),
      );
      await session.prompt({ prompt: 'synthetic' });
      assert.equal(f.dispatched(), 1);
    } finally {
      await session.close();
    }
  }
  const f = fixture(t),
    session = await f.driver.open(f.config, f.cwd, undefined, f.callbacks);
  try {
    assert.deepEqual(f.wires.find((wire) => wire.method === 'session/new').params.mcpServers, []);
  } finally {
    await session.close();
  }
});

test('ACP rejects invalid task descriptors and already revoked capabilities before launch', async (t) => {
  const f = fixture(t);
  for (const url of [
    'https://127.0.0.1:23456/mcp',
    'http://localhost:23456/mcp',
    'http://127.0.0.1:23456/mcp?url=x',
    'http://127.0.0.1:23456/anything',
  ])
    await assert.rejects(f.open(undefined, { ...f.taskTools, url }), /连接无效/);
  await assert.rejects(f.open(undefined, { ...f.taskTools, token: 'wrong' }), /连接无效/);
  f.revoke();
  await assert.rejects(f.open(), /授权已失效/);
  assert.equal(f.launches.length, 0);
});

test('ACP rechecks authorization after initialize, new and load, and never reaches prompt on late revocation', async (t) => {
  for (const held of ['initialize', 'session/new', 'session/load']) {
    const f = fixture(t, 'true', held);
    const opening = f.open(held === 'session/load' ? 'existing' : undefined);
    const failed = assert.rejects(opening, /授权已失效/);
    await f.wait(held);
    f.revoke();
    f.children[0]!.send!('release');
    await failed;
    assert.equal(f.dispatched(), 0);
    assert.equal(
      f.wires.some((wire) => wire.method === 'session/prompt'),
      false,
    );
  }
});

test('ACP rechecks configuration awaits and final dispatch hook before parent prompt', async (t) => {
  for (const [held, input] of [
    ['session/set_config_option', { modelId: 'model' }],
    ['session/set_mode', { modeId: 'mode' }],
  ] as const) {
    const f = fixture(t, 'true', held),
      session = await f.open();
    try {
      const prompt = session.prompt({ prompt: 'synthetic', ...input }),
        failed = assert.rejects(prompt, /授权已失效/);
      await f.wait(held);
      f.revoke();
      f.children[0]!.send!('release');
      await failed;
      assert.equal(f.dispatched(), 0);
      assert.equal(
        f.wires.some((wire) => wire.method === 'session/prompt'),
        false,
      );
    } finally {
      await session.close();
    }
  }
  const f = fixture(t);
  f.taskTools.onPromptDispatch = () => {
    throw new Error('private');
  };
  const session = await f.open();
  try {
    await assert.rejects(session.prompt({ prompt: 'synthetic' }), /未派发父回合/);
    assert.equal(
      f.wires.some((wire) => wire.method === 'session/prompt'),
      false,
    );
  } finally {
    await session.close();
  }
});

test('real synthetic ACP stdio initializes MCP before prompt but invokes business only after dispatch', async (t) => {
  const f = fixture(t, 'true', '', 'mcp');
  let calls = 0;
  const mcp = await createTaskMcp({
    current: f.taskTools.assertCurrent,
    call: async (name, args) => {
      assert.equal(f.dispatched(), 1);
      assert.equal(name, 'moor_task_create');
      assert.equal(args.grantId, 'grant');
      calls++;
      return { confirmed: true };
    },
  });
  t.after(() => mcp.close());
  Object.assign(f.taskTools, mcp.endpoint);
  const session = await f.open();
  try {
    assert.equal(calls, 0);
    await session.prompt({ prompt: 'synthetic parent' });
    assert.equal(calls, 1);
  } finally {
    await session.close();
  }
});

test('task MCP endpoint credentials are removed from echoed ACP updates and upstream failures', async (t) => {
  for (const scenario of ['echo', 'startup-error', 'prompt-error']) {
    const f = fixture(t, 'true', '', scenario);
    if (scenario === 'startup-error') {
      await assert.rejects(f.open(), (error: any) => {
        assert.doesNotMatch(error.message, new RegExp(f.taskTools.token));
        assert.ok(!error.message.includes(f.taskTools.url));
        return true;
      });
    } else {
      const session = await f.open();
      try {
        if (scenario === 'prompt-error')
          await assert.rejects(session.prompt({ prompt: 'synthetic' }), (error: any) => {
            assert.ok(!error.message.includes(f.taskTools.token));
            assert.ok(!error.message.includes(f.taskTools.url));
            return true;
          });
        else {
          await session.prompt({ prompt: 'synthetic' });
          assert.equal(f.updates.length, 1);
          assert.ok(!JSON.stringify(f.updates).includes(f.taskTools.token));
          assert.ok(!JSON.stringify(f.updates).includes(f.taskTools.url));
        }
      } finally {
        await session.close();
      }
    }
  }
});
