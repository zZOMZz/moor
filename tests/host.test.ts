import { syntheticCapabilities } from './support/agent-capabilities';
import test from 'node:test';
import strict from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { RuntimeStore } from '../src/runtime/store';
import type { AgentDriver } from '../src/runtime/agent';
import { Store } from '../src/relay/accounts';
import { Flock, LoroDoc, delta, metas, mirror, putMeta, vv } from '../src/model';
import type { Mutation, RuntimeWorkspace } from '../src/protocol';
const ws: RuntimeWorkspace = {
  id: 'lw_synthetic',
  name: '验证工作区',
  userId: 'local:synthetic',
  machineId: 'machine-a',
  projects: [{ id: 'project-a', name: '合成项目', rootPath: '/synthetic/project' }],
  agents: [{ id: 'agent-a', name: '合成 Agent', cliType: 'builtin', agentType: 'codex' }],
};
function fixture(file = ':memory:') {
  const store = new RuntimeStore(file);
  Object.assign(store.workspace, structuredClone(ws));
  store.save('identity', Buffer.from(JSON.stringify(store.workspace)));
  store.machine.set(['localProject', 'project-a'], ws.projects[0]);
  store.machine.set(['agentConfig', 'agent-a'], { ...ws.agents[0], machineId: ws.machineId });
  store.saveMachine();
  let dispatches = 0;
  const dispatched: any[] = [];
  let callbacks: Parameters<AgentDriver['open']>[3];
  let complete!: () => void;
  let prompted!: () => void;
  const started = new Promise<void>((r) => (prompted = r));
  const driver: AgentDriver = {
    async open(_config, _cwd, nativeId, c) {
      callbacks = c;
      return {
        id: nativeId ?? 'synthetic-native',
        capabilities: syntheticCapabilities,
        async prompt(input) {
          dispatches++;
          dispatched.push(input);
          prompted();
          await new Promise<void>((r) => (complete = r));
        },
        async cancel() {
          complete?.();
        },
        close() {
          complete?.();
        },
      };
    },
  };
  const host = new HostWorkspace(
    store,
    driver,
    () => {},
    () => {},
  );
  return {
    host,
    store,
    journal: store.journal,
    get meta() {
      return store.meta;
    },
    machine: store.machine,
    getDoc: (name: string) => host.active.get(name.slice(8))?.doc ?? store.doc(name.slice(8)),
    dispatches: () => dispatches,
    dispatched,
    started,
    permission: () =>
      callbacks.permission({
        toolCall: { toolCallId: 'tool-1', title: 'Synthetic edit' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      }),
    finish: async () => {
      const done = [...host.active.values()].map((r) => r.done);
      complete?.();
      await Promise.all(done);
    },
    close: () => {
      host.close();
      store.close();
    },
  };
}
function request(
  f: ReturnType<typeof fixture>,
  sessionId = 'session-a',
  config: Record<string, unknown> = {},
) {
  const source = f.getDoc('session-' + sessionId),
    doc = new LoroDoc();
  doc.import(source.export({ mode: 'snapshot' }));
  const before = vv(doc),
    flock = Flock.fromFile(f.meta.exportFile()),
    version = flock.version(),
    old = metas(flock)['session-' + sessionId],
    turnId = crypto.randomUUID();
  const view = mirror(doc, sessionId),
    inputConfig = {
      prompt: '合成指令',
      cliType: 'builtin',
      agentType: 'codex',
      mcpServerIds: [],
      taskToolsEnabled: false,
      ...config,
    };
  view.setState((s: any) => {
    s.history.push({
      id: turnId,
      role: 'user',
      userId: ws.userId,
      timestamp: '2026-01-01T00:00:00Z',
      status: 'pending',
      finished: true,
      items: [{ type: 'text', text: '合成指令' }],
      inputConfig,
      fileDiff: null,
    });
  });
  view.dispose();
  doc.commit();
  putMeta(
    flock,
    'session-' + sessionId,
    old
      ? { latestUserMsgId: turnId, lastMessageAt: 100 }
      : {
          id: sessionId,
          machineId: ws.machineId,
          userId: ws.userId,
          createdAt: '2026-01-01T00:00:00Z',
          cliType: 'builtin',
          agentType: 'codex',
          agentConfigId: 'agent-a',
          project: { kind: 'local', localProjectId: 'project-a' },
          status: { type: 'idle' },
          isArchived: false,
          latestUserMsgId: turnId,
          lastMessageAt: 100,
        },
  );
  return {
    operationId: crypto.randomUUID(),
    sessionId,
    workspaceId: ws.id,
    kind: 'turn',
    expectedTurnId: old?.latestUserMsgId ?? null,
    update: delta(doc, before),
    metaBundle: flock.exportJson(version),
  } as Mutation;
}
test('relay database contains only identity and organization records, never session bodies', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const secret = await store.setup('synthetic@example.com', 'synthetic-password-only'),
    owner = store.owner(secret),
    device = store.redeem(store.pair(owner), 'Test Mac');
  store.bind(store.device(owner, device.id), ws.machineId, [ws]);
  strict.deepEqual(
    store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name),
    [
      'account',
      'device',
      'host_binding',
      'login',
      'pair',
      'project',
      'project_replica',
      'workspace',
    ],
  );
  strict.equal(store.device(owner, device.id).catalog, '[]');
  strict.throws(() => store.device('another-account', device.id));
  store.revoke(owner, device.id);
  strict.throws(() => store.deviceToken(device.token));
});
test('pairing codes expire, can only be used once, and cannot move an existing device to a different host', async (t) => {
  let now = 0;
  const store = new Store(':memory:', () => now);
  t.after(() => store.close());
  const secret = await store.setup('synthetic@example.com', 'synthetic-password-only'),
    owner = store.owner(secret),
    code = store.pair(owner),
    device = store.redeem(code, 'Mac');
  strict.throws(() => store.redeem(code, 'Again'));
  const expired = store.pair(owner);
  now = 300001;
  strict.throws(() => store.redeem(expired, 'Late'));
  store.bind(store.device(owner, device.id), ws.machineId, [ws]);
  strict.throws(() => store.bind(store.device(owner, device.id), 'another-host', []));
});
test('delivery commits document, metadata and receipt atomically before Agent prompt', async (t) => {
  const f = fixture();
  t.after(f.close);
  const m = request(f),
    result = await f.host.mutate(m, 'project-a');
  strict.equal(result.delivered, true);
  const persisted = mirror(f.store.doc(m.sessionId), m.sessionId);
  strict.equal(persisted.getState().history.length, 2);
  persisted.dispose();
  strict.equal(f.journal.lookup(ws.id, m).phase, 'accepted');
  strict.ok((await f.host.read(m.sessionId)).update);
  await f.started;
  strict.equal(f.dispatches(), 1);
  strict.deepEqual(await f.host.mutate(m), result);
  strict.equal(f.dispatches(), 1);
  await strict.rejects(f.host.mutate({ ...m, sessionId: 'other' }));
});
test('concurrent and offline turns never start a second prompt', async (t) => {
  const f = fixture();
  t.after(f.close);
  const a = request(f),
    b = request(f);
  const outcomes = await Promise.allSettled([f.host.mutate(a), f.host.mutate(b)]);
  strict.equal(outcomes.filter((v) => v.status === 'fulfilled').length, 1);
  await f.started;
  f.host.close();
  await strict.rejects(f.host.mutate(request(f, 'offline-session')));
  strict.equal(f.dispatches(), 1);
  strict.equal(metas(f.meta)['session-offline-session'], undefined);
});
test('failed persistence rolls back receipt and document and cannot dispatch', async (t) => {
  const f = fixture();
  t.after(f.close);
  const m = request(f);
  f.store.journal.db.exec(
    "CREATE TRIGGER fail_snapshot BEFORE INSERT ON session BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END",
  );
  await strict.rejects(f.host.mutate(m));
  strict.equal(f.journal.has(m.operationId), false);
  strict.equal(metas(f.meta)['session-' + m.sessionId], undefined);
  strict.equal(f.dispatches(), 0);
});
test('restart retains receipt and history, settles interrupted turns and never replays', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'moor-runtime-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'host.sqlite'),
    f = fixture(file),
    m = request(f);
  const first = await f.host.mutate(m);
  await f.started;
  // Save an interrupted snapshot, then close the owner before reopening its database.
  const snapshot = f.store.doc(m.sessionId).export({ mode: 'snapshot' });
  f.close();
  const seed = new RuntimeStore(file);
  seed.journal.db.prepare('UPDATE session SET snapshot=? WHERE id=?').run(snapshot, m.sessionId);
  seed.close();
  const next = fixture(file);
  t.after(next.close);
  strict.equal(next.dispatches(), 0);
  strict.deepEqual(await next.host.mutate(m), first);
  strict.equal(next.dispatches(), 0);
  const view = mirror(next.store.doc(m.sessionId), m.sessionId);
  strict.ok(view.getState().history.every((turn) => turn.finished));
  view.dispose();
  await next.host.mutate(request(next));
  await next.started;
  strict.equal(next.dispatches(), 1);
});
function choice(f: ReturnType<typeof fixture>, m: Mutation, optionId: string) {
  const doc = new LoroDoc();
  doc.import(f.getDoc('session-' + m.sessionId).export({ mode: 'snapshot' }));
  const version = vv(doc),
    view = mirror(doc, m.sessionId);
  let requestId = '';
  view.setState((s: any) => {
    const item = s.history.at(-1).items.find((i: any) => i.permissionRequest);
    requestId = item.permissionRequest.requestId;
    item.permissionRequest.outcome = { outcome: 'selected', optionId };
  });
  view.dispose();
  doc.commit();
  return {
    ...m,
    operationId: crypto.randomUUID(),
    kind: 'permission' as const,
    expectedTurnId: f.journal.lookup(ws.id, m).turn_id,
    requestId,
    update: delta(doc, version),
    metaBundle: undefined,
  };
}
test('approval reaches only the active request; competing and late choices fail', async (t) => {
  const f = fixture();
  t.after(f.close);
  const m = request(f);
  await f.host.mutate(m);
  await f.started;
  const permission = f.permission(),
    allow = choice(f, m, 'allow'),
    deny = choice(f, m, 'deny');
  await strict.rejects(f.host.mutate(allow, 'other-project'));
  const result = await f.host.mutate(allow);
  strict.deepEqual(await permission, { outcome: { outcome: 'selected', optionId: 'allow' } });
  await strict.rejects(f.host.mutate(deny));
  strict.deepEqual(await f.host.mutate(allow), result);
  strict.equal(f.dispatches(), 1);
  await f.finish();
  await strict.rejects(f.host.mutate({ ...deny, operationId: crypto.randomUUID() }));
});
test('cancel binds exact assistant turn and invalidates pending permission', async (t) => {
  const f = fixture();
  t.after(f.close);
  const m = request(f);
  await f.host.mutate(m);
  await f.started;
  const permission = f.permission(),
    allow = choice(f, m, 'allow');
  await strict.rejects(f.host.cancel(m.sessionId, 'stale-turn'));
  const turnId = f.host.active.get(m.sessionId)!.turnId;
  strict.deepEqual(await f.host.cancel(m.sessionId, turnId, 'project-a'), { success: true });
  strict.deepEqual(await permission, { outcome: { outcome: 'cancelled' } });
  await strict.rejects(f.host.mutate(allow));
  await strict.rejects(f.host.cancel(m.sessionId, turnId));
});
test('project and workspace scope are validated before receipt creation or retry', async (t) => {
  const f = fixture();
  t.after(f.close);
  const m = request(f);
  await strict.rejects(f.host.mutate(m, 'other-project'));
  await strict.rejects(f.host.mutate({ ...m, workspaceId: 'other-workspace' }));
  strict.equal(f.journal.has(m.operationId), false);
  await f.host.mutate(m, 'project-a');
  strict.equal(f.host.list('project-a').length, 1);
  strict.equal(f.host.list('other-project').length, 0);
  await strict.rejects(f.host.read(m.sessionId, undefined, 'other-project'));
  await strict.rejects(f.host.mutate(m, 'other-project'));
  await strict.rejects(f.host.cancel(m.sessionId, 'turn', 'other-project'));
});
test('host obtains ACP capabilities and preserves selected input across retry', async (t) => {
  const f = fixture();
  t.after(f.close);
  await strict.rejects(f.host.refreshAgentOptions('unknown', 'project-a'));
  await strict.rejects(f.host.refreshAgentOptions('agent-a', 'unknown'));
  const agent = await f.host.refreshAgentOptions('agent-a', 'project-a');
  strict.equal(agent.runConfig!.models.length, 2);
  const config = {
    modelId: 'model-b',
    modeId: 'agent',
    configOptionValues: { reasoning_effort: 'medium' },
  };
  const m = request(f, 'selected-settings', config);
  await f.host.mutate(m);
  await f.started;
  strict.deepEqual(f.dispatched[0].configOptionValues, config.configOptionValues);
  f.host.workspace.agents[0].runConfig = undefined;
  await f.host.mutate(m);
  strict.equal(f.dispatches(), 1);
});
test('unsupported models, efforts, permission modes and launch settings fail before staging', async (t) => {
  const f = fixture();
  t.after(f.close);
  await f.host.refreshAgentOptions('agent-a', 'project-a');
  for (const config of [
    { modelId: 'unknown' },
    { modeId: 'unknown' },
    { modelId: 'model-b', configOptionValues: { reasoning_effort: 'high' } },
    { modelId: 'model-a', configOptionValues: { reasoning_effort: 'low', shell: 'injected' } },
    { configOptionValues: { approval_policy: 'never' } },
    { command: '/injected' },
  ]) {
    const m = request(f, 'invalid-settings', config);
    await strict.rejects(f.host.mutate(m));
    strict.equal(f.journal.has(m.operationId), false);
  }
  strict.equal(f.dispatches(), 0);
});
