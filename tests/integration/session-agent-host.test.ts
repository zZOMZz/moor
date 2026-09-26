import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HostWorkspace } from '@moor/host/sessions/workspace';
import { RuntimeStore } from '@moor/host/persistence/store';
import { Flock, delta, metas, mirror, putMeta, vv } from '@moor/session/model';
import type { Mutation } from '@moor/protocol/protocol';
import type { AgentConfig, AgentDriver } from '@moor/host/agents/driver';
import { syntheticCapabilities } from '../fixtures/agent-capabilities';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(t: { after(fn: () => unknown): void }, realProgram = false) {
  const root = mkdtempSync(join(tmpdir(), 'moor-agent-binding-'));
  const store = new RuntimeStore(':memory:');
  const project = store.registerProject(root);
  const config: AgentConfig = {
    id: 'synthetic-agent',
    name: 'Synthetic',
    cliType: 'custom',
    agentType: 'synthetic',
    machineId: store.workspace.machineId,
    customAcp: {
      command: realProgram ? join(root, 'synthetic-cli') : '/synthetic/agent-v1',
      args: ['--synthetic-secret-v1'],
    },
  };
  if (realProgram) writeFileSync(config.customAcp!.command, 'synthetic version 1');
  store.registerAgent('synthetic-preset', config);
  const opened: { config: AgentConfig; cwd: string; nativeId?: string }[] = [];
  const prompts: unknown[] = [];
  let onCapture = async () => {},
    onOpen = async () => {},
    onClose = async () => {},
    onPrompt = async () => {},
    closes = 0;
  let callbacks: Parameters<AgentDriver['open']>[3];
  const host = new HostWorkspace(
    store,
    {
      async open(agent, cwd, nativeId, value) {
        callbacks = value;
        opened.push({ config: structuredClone(agent), cwd, nativeId });
        await onOpen();
        return {
          id: nativeId ?? 'native-' + randomUUID(),
          capabilities: syntheticCapabilities,
          async prompt(input) {
            prompts.push(input);
            await onPrompt();
          },
          async cancel() {},
          async close() {
            closes++;
            await onClose();
          },
        };
      },
    },
    () => {},
    () => {},
    undefined,
    {
      async capture() {
        await onCapture();
        return {
          version: 1,
          bytesRead: 0,
          files: [],
          source: 'directory',
          partial: false,
          enumerationComplete: true,
          issues: [],
        };
      },
      async tree() {
        return {
          entries: [],
          source: 'directory',
          partial: false,
          enumerationComplete: true,
          issues: [],
        };
      },
    },
  );
  t.after(() => {
    host.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const scope = (sessionId = 'session') => ({
    workspaceId: store.workspace.id,
    userId: store.workspace.userId,
    machineId: store.workspace.machineId,
    localProjectId: project,
    sessionId,
  });
  const request = (sessionId = 'session', agentId = config.id): Mutation => {
    const doc = store.doc(sessionId),
      before = vv(doc),
      view = mirror(doc, sessionId);
    const flock = Flock.fromFile(store.meta.exportFile()),
      version = flock.version();
    const previous = metas(flock)['session-' + sessionId],
      turn = randomUUID();
    const inputConfig = {
      prompt: 'synthetic',
      cliType: config.cliType,
      agentType: config.agentType,
      mcpServerIds: [],
      taskToolsEnabled: false,
    };
    view.setState((state) => {
      state.history.push({
        id: turn,
        userId: store.workspace.userId,
        userTurnId: undefined,
        read: undefined,
        role: 'user',
        timestamp: '2026-09-12T00:00:00Z',
        finished: true,
        status: 'pending',
        items: [{ type: 'text', text: 'synthetic' }],
        inputConfig,
        fileDiff: null,
      });
    });
    view.dispose();
    doc.commit();
    putMeta(
      flock,
      'session-' + sessionId,
      previous
        ? { latestUserMsgId: turn, lastMessageAt: 2 }
        : {
            id: sessionId,
            userId: store.workspace.userId,
            machineId: store.workspace.machineId,
            createdAt: '2026-09-12T00:00:00Z',
            cliType: config.cliType,
            agentType: config.agentType,
            agentConfigId: agentId,
            project: { kind: 'local', localProjectId: project },
            status: { type: 'idle' },
            isArchived: false,
            latestUserMsgId: turn,
            lastMessageAt: 1,
          },
    );
    return {
      workspaceId: store.workspace.id,
      sessionId,
      operationId: randomUUID(),
      kind: 'turn',
      expectedTurnId: (previous?.latestUserMsgId as string) ?? null,
      update: delta(doc, before),
      metaBundle: flock.exportJson(version),
    };
  };
  const advance = () => {
    const next = store.registerAgent('synthetic-preset', {
      ...config,
      name: 'Synthetic v2',
      customAcp: { command: '/synthetic/agent-v2', args: ['--synthetic-secret-v2'] },
    });
    host.updateCatalogue();
    return next;
  };
  return {
    root,
    store,
    host,
    project,
    config,
    scope,
    request,
    advance,
    opened,
    prompts,
    capture: (fn: typeof onCapture) => {
      onCapture = fn;
    },
    opening: (fn: typeof onOpen) => {
      onOpen = fn;
    },
    closing: (fn: typeof onClose) => {
      onClose = fn;
    },
    prompting: (fn: typeof onPrompt) => {
      onPrompt = fn;
    },
    callbacks: () => callbacks,
    closes: () => closes,
    settle: async () => {
      await Promise.all([...host.active.values()].map((r) => r.done));
    },
  };
}

test('new-session catalogue excludes legacy builtin Claude while retaining custom ACP', (t) => {
  const f = fixture(t);
  f.store.registerAgent('legacy-claude', {
    id: 'legacy-claude',
    name: 'Legacy Claude',
    cliType: 'builtin',
    agentType: 'claude',
    machineId: f.store.workspace.machineId,
  });
  f.store.registerAgent('legacy-pathless-codex', {
    id: 'legacy-pathless-codex',
    name: 'Legacy pathless Codex',
    cliType: 'builtin',
    agentType: 'codex',
    machineId: f.store.workspace.machineId,
  });
  f.host.updateCatalogue();
  assert.deepEqual(
    f.host.workspace.agents.map((agent) => agent.id),
    [f.config.id],
  );
});

test('a committed output publication failure remains failed when prompt returns and terminal reads recover', async (t) => {
  const f = fixture(t),
    prompting = signal(),
    release = signal(),
    closed = signal();
  let promptReturned = false;
  f.prompting(async () => {
    prompting.resolve();
    await release.promise;
    promptReturned = true;
  });
  f.closing(async () => closed.resolve());
  t.after(release.resolve);
  await f.host.mutate(f.request(), f.project);
  await prompting.promise;
  const run = f.host.active.get('session')!;
  const confirm = f.store.confirmOutput.bind(f.store);
  const confirmation = t.mock.method(
    f.store,
    'confirmOutput',
    (...args: Parameters<RuntimeStore['confirmOutput']>) => {
      confirm(...args);
      throw Error('synthetic failure after confirmed import');
    },
  );
  const reload = t.mock.method(f.store, 'doc', () => {
    throw Error('synthetic durable reload failure');
  });
  assert.throws(
    () =>
      f.callbacks().update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'durable output before publication failure' },
      }),
    /已保存输出无法重新读取/,
  );
  assert.equal(run.stopped, true);
  assert.equal(run.terminal?.status, 'failed');
  assert.equal(f.host.settlementFailures.get('session'), run.doc);
  assert.equal((await f.host.read('session', undefined, f.project)).persisted, false);
  await closed.promise;
  assert.equal(promptReturned, false, 'publication failure closes the still-running Agent');
  confirmation.mock.restore();
  reload.mock.restore();
  release.resolve();
  await run.done;
  assert.equal(promptReturned, true, 'the synthetic Agent returns normally after close');
  assert.ok(f.closes() > 0);
  assert.equal(run.terminal?.status, 'failed');
  assert.equal(f.host.active.has('session'), false);
  assert.equal(f.host.settlementFailures.has('session'), false);
  const response = await f.host.read('session', undefined, f.project);
  assert.equal(response.persisted, true);
  assert.equal(response.persistenceError, undefined);
  const doc = f.store.doc('session'),
    view = mirror(doc, 'session');
  try {
    const terminal = view.getState().history.find((turn) => turn.id === run.turnId)!;
    assert.equal(terminal.finished, true);
    assert.equal(terminal.status, 'failed');
    assert.ok(
      terminal.items?.some(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          'type' in item &&
          item.type === 'text' &&
          'text' in item &&
          item.text === 'durable output before publication failure',
      ),
    );
  } finally {
    view.dispose();
    doc.free();
  }
});

test('accepted Agent snapshot survives catalogue replacement while before-capture waits', async (t) => {
  const f = fixture(t),
    held = signal(),
    release = signal();
  f.capture(async () => {
    held.resolve();
    await release.promise;
  });
  t.after(release.resolve);
  const request = f.request();
  const receipt = await f.host.mutate(request, f.project);
  await held.promise;
  assert.equal(receipt.delivered, true);
  assert.deepEqual(f.store.agents.binding(f.scope()), f.config);
  const next = f.advance();
  assert.deepEqual(
    f.host.workspace.agents.map((a) => a.id),
    [next.id],
  );
  release.resolve();
  await f.settle();
  assert.deepEqual(
    f.opened.map((a) => a.config),
    [f.config],
  );
  assert.equal(f.prompts.length, 1);
  assert.deepEqual(await f.host.mutate(request, f.project), receipt);
  assert.equal(f.opened.length, 1);
  const read = await f.host.read('session', undefined, f.project);
  assert.equal(read.agent?.id, f.config.id);
  assert.equal(JSON.stringify(read).includes('synthetic-secret'), false);
  assert.equal(JSON.stringify(read).includes('/synthetic/agent'), false);
  await f.host.mutate(f.request(), f.project);
  await f.settle();
  assert.deepEqual(f.opened[1].config, f.config);
  assert.equal(f.opened[1].nativeId, f.store.nativeSession('session'));
  await f.host.mutate(f.request('new-session', next.id), f.project);
  await f.settle();
  assert.deepEqual(f.opened[2].config, next);
});

test('changing private launch bytes after acceptance cannot retarget the active turn', async (t) => {
  const f = fixture(t),
    held = signal(),
    release = signal();
  f.capture(async () => {
    held.resolve();
    await release.promise;
  });
  t.after(release.resolve);
  await f.host.mutate(f.request(), f.project);
  await held.promise;
  f.store.machine.set(['agentConfig', f.config.id], {
    ...f.config,
    customAcp: { command: '/synthetic/evil', args: [] },
  });
  assert.throws(() => f.store.saveMachine(), /配置版本/);
  release.resolve();
  await f.settle();
  assert.deepEqual(f.opened[0].config, f.config);
  assert.equal(f.prompts.length, 1);
});

test('acceptance failure rolls back session binding with document and receipt', async (t) => {
  const f = fixture(t),
    request = f.request();
  f.store.journal.db.exec(
    "CREATE TRIGGER synthetic_fail BEFORE INSERT ON session BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
  );
  await assert.rejects(f.host.mutate(request, f.project), /synthetic failure/);
  assert.equal(f.store.agents.binding(f.scope()), undefined);
  assert.equal(f.store.journal.has(request.operationId), false);
  assert.equal(metas(f.store.meta)['session-session'], undefined);
  assert.equal(f.opened.length, 0);
  f.store.journal.db.exec('DROP TRIGGER synthetic_fail');
  assert.equal((await f.host.mutate(request, f.project)).delivered, true);
  await f.settle();
  assert.equal(f.opened.length, 1);
});

test('a retired version cannot accept a previously undelivered new-session request', async (t) => {
  const f = fixture(t),
    request = f.request();
  f.advance();
  await assert.rejects(f.host.mutate(request, f.project), /配置不可用/);
  assert.equal(f.store.journal.has(request.operationId), false);
  assert.equal(f.store.agents.binding(f.scope()), undefined);
  assert.equal(f.opened.length, 0);
});

test('a delayed capability probe cannot publish across retired versions or changed identity', async (t) => {
  for (const changed of ['version', 'identity', 'project', 'project mutation', 'closed'] as const) {
    await t.test(changed, async (t) => {
      const f = fixture(t),
        held = signal(),
        release = signal();
      f.opening(async () => {
        held.resolve();
        await release.promise;
      });
      t.after(release.resolve);
      const probe = f.host.refreshAgentOptions(f.config.id, f.project);
      const rejected = assert.rejects(probe, /变化|停止|退出/);
      await held.promise;
      if (changed === 'version') f.advance();
      else if (changed === 'identity') f.store.workspace.userId = 'local:other';
      else if (changed === 'project') f.store.workspace.projects = [];
      else if (changed === 'project mutation') f.store.workspace.projects[0].name = 'Changed';
      else f.host.close();
      release.resolve();
      await rejected;
      assert.equal(f.store.machine.get(['capabilities', f.config.id]), undefined);
      assert.equal(f.closes(), 1);
      assert.equal(f.prompts.length, 0);
    });
  }
});

test('retired session capability refresh resolves the bound version and rejects other scopes', async (t) => {
  const f = fixture(t);
  await f.host.mutate(f.request(), f.project);
  await f.settle();
  const next = f.advance();
  const result = await f.host.refreshAgentOptions(f.config.id, f.project, 'session');
  assert.equal(result.id, f.config.id);
  assert.deepEqual(f.opened.at(-1)?.config, f.config);
  assert.equal(f.opened.at(-1)?.nativeId, undefined);
  assert.equal(f.store.machine.get(['capabilities', next.id]), undefined);
  await assert.rejects(f.host.refreshAgentOptions(next.id, f.project, 'session'));
  await assert.rejects(f.host.refreshAgentOptions(f.config.id, f.project, 'other-session'));
  await assert.rejects(f.host.refreshAgentOptions(f.config.id, 'other-project', 'session'));
  assert.equal(f.prompts.length, 1);
});

test('a delayed capability probe cannot publish after its cwd is replaced at the same path', async (t) => {
  for (const existing of [false, true]) {
    await t.test(existing ? 'existing shared session' : 'new session', async (t) => {
      const f = fixture(t),
        held = signal(),
        release = signal();
      if (existing) {
        await f.host.mutate(f.request(), f.project);
        await f.settle();
      }
      f.store.machine.set(['capabilities', f.config.id], undefined as never);
      const before = f.store.machine.get(['capabilities', f.config.id]),
        closes = f.closes(),
        promptCount = f.prompts.length,
        previousRoot = f.root + '-previous';
      t.after(() => rmSync(previousRoot, { recursive: true, force: true }));
      f.opening(async () => {
        held.resolve();
        await release.promise;
      });
      t.after(release.resolve);
      const rejected = assert.rejects(
        f.host.refreshAgentOptions(f.config.id, f.project, existing ? 'session' : undefined),
        /执行目录已变化/,
      );
      await held.promise;
      renameSync(f.root, previousRoot);
      mkdirSync(f.root);
      release.resolve();
      await rejected;
      assert.deepEqual(f.store.machine.get(['capabilities', f.config.id]), before);
      assert.equal(f.closes(), closes + 1);
      assert.equal(f.prompts.length, promptCount);
    });
  }
});

test('capability cache remains unchanged when cwd is replaced while the temporary session closes', async (t) => {
  const f = fixture(t),
    held = signal(),
    release = signal(),
    previousRoot = f.root + '-previous';
  t.after(() => rmSync(previousRoot, { recursive: true, force: true }));
  f.closing(async () => {
    held.resolve();
    await release.promise;
  });
  t.after(release.resolve);
  const rejected = assert.rejects(
    f.host.refreshAgentOptions(f.config.id, f.project),
    /执行目录已变化/,
  );
  await held.promise;
  assert.equal(f.store.machine.get(['capabilities', f.config.id]), undefined);
  renameSync(f.root, previousRoot);
  mkdirSync(f.root);
  release.resolve();
  await rejected;
  assert.equal(f.store.machine.get(['capabilities', f.config.id]), undefined);
  assert.equal(f.closes(), 1);
});

test('capability refresh rejects a missing cwd before opening the Agent', async (t) => {
  const f = fixture(t);
  rmSync(f.root, { recursive: true });
  await assert.rejects(f.host.refreshAgentOptions(f.config.id, f.project), /执行目录.*不可用/);
  assert.equal(f.opened.length, 0);
});

test('model catalogs are isolated by project, shared by sessions, and invalidated by program replacement', async (t) => {
  const f = fixture(t, true);
  const first = await f.host.refreshAgentOptions(f.config.id, f.project);
  assert.deepEqual(first.runConfig, syntheticCapabilities);
  assert.equal(first.capabilityContext.localProjectId, f.project);
  assert.equal(first.capabilityContext.sessionId, undefined);
  assert.equal(JSON.stringify(first).includes(f.root), false, 'paths remain on the execution host');
  assert.equal(JSON.stringify(first).includes('synthetic-secret'), false);
  assert.equal(
    f.host.agentDescriptor(f.config).runConfig,
    undefined,
    'global catalogue does not claim project options',
  );
  assert.deepEqual(f.host.agentDescriptor(f.config, f.project).runConfig, syntheticCapabilities);
  const otherRoot = join(f.root, 'other');
  mkdirSync(otherRoot);
  const other = f.store.registerProject(otherRoot);
  f.host.updateCatalogue();
  assert.equal(f.host.agentDescriptor(f.config, other).runConfig, undefined);
  const second = await f.host.refreshAgentOptions(f.config.id, other);
  assert.notEqual(
    second.capabilityContext.directoryFingerprint,
    first.capabilityContext.directoryFingerprint,
  );
  await f.host.mutate(f.request(), f.project);
  await f.settle();
  assert.deepEqual(
    (await f.host.read('session', undefined, f.project)).agent?.runConfig,
    syntheticCapabilities,
  );
  const before = f.opened.length;
  await f.host.refreshAgentOptions(f.config.id, f.project, 'session');
  assert.deepEqual(
    (await f.host.read('session', undefined, f.project)).agent?.runConfig,
    syntheticCapabilities,
  );
  assert.equal(f.opened.length, before, 'entering a session reuses the project catalog');
  writeFileSync(f.config.customAcp!.command, 'synthetic version 2 with new model discovery');
  assert.equal(f.host.agentDescriptor(f.config, f.project).runConfig, undefined);
  assert.equal((await f.host.read('session', undefined, f.project)).agent?.runConfig, undefined);
  const updated = await f.host.refreshAgentOptions(f.config.id, f.project);
  assert.notEqual(
    updated.capabilityContext.programFingerprint,
    first.capabilityContext.programFingerprint,
  );
});

test('an in-place program upgrade during a held capability probe rejects the late observation', async (t) => {
  const f = fixture(t, true),
    held = signal(),
    release = signal();
  f.opening(async () => {
    held.resolve();
    await release.promise;
  });
  t.after(release.resolve);
  const rejected = assert.rejects(f.host.refreshAgentOptions(f.config.id, f.project), /程序.*变化/);
  await held.promise;
  writeFileSync(f.config.customAcp!.command, 'synthetic replacement with different metadata');
  release.resolve();
  await rejected;
  assert.equal(f.host.agentDescriptor(f.config, f.project).runConfig, undefined);
  assert.equal(f.closes(), 1);
  assert.equal(f.prompts.length, 0);
});

test('an Agent launch error never persists private executable paths or arguments', async (t) => {
  const f = fixture(t);
  f.opening(async () => {
    throw new Error('/synthetic/agent-v1 --synthetic-secret-v1');
  });
  await f.host.mutate(f.request(), f.project);
  await f.settle();
  const view = mirror(f.store.doc('session'), 'session');
  const serialized = JSON.stringify(view.getState());
  view.dispose();
  assert.equal(serialized.includes('/synthetic/agent-v1'), false);
  assert.equal(serialized.includes('synthetic-secret'), false);
  assert.match(serialized, /Agent.*失败/);
});

test('failed capability initialization is reused until explicit refresh', async (t) => {
  const f = fixture(t);
  f.opening(async () => {
    throw Error('synthetic unavailable');
  });
  await assert.rejects(f.host.refreshAgentOptions(f.config.id, f.project));
  await assert.rejects(f.host.refreshAgentOptions(f.config.id, f.project));
  assert.equal(f.opened.length, 1);
  f.opening(async () => {});
  await assert.rejects(f.host.refreshAgentOptions(f.config.id, f.project));
  assert.equal(f.opened.length, 1, 'opening another menu cannot retry a failed probe');
  await f.host.refreshAgentOptions(f.config.id, f.project, undefined, undefined, true);
  assert.equal(f.opened.length, 2);
});
