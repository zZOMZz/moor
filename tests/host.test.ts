import { syntheticCapabilities } from './support/agent-capabilities';
import test from 'node:test';
import strict from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { RuntimeStore } from '../src/runtime/store';
import type { AgentDriver } from '../src/runtime/agent';
import { Store } from '../src/relay/accounts';
import { Flock, LoroDoc, delta, metas, mirror, putMeta, vv } from '../src/model';
import {
  sessionActionSchema,
  type Mutation,
  type RuntimeWorkspace,
  type SessionAction,
} from '../src/protocol';
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
  let finishRequested = false;
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
          await new Promise<void>((r) => {
            complete = r;
            if (finishRequested) complete();
          });
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
      finishRequested = true;
      complete?.();
      await Promise.all(done);
      finishRequested = false;
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
      'external_identity',
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
  const rootPath = mkdtempSync(join(tmpdir(), 'moor-agent-options-'));
  t.after(() => rmSync(rootPath, { recursive: true, force: true }));
  f.store.machine.set(['localProject', 'project-a'], { ...ws.projects[0], rootPath });
  f.host.updateCatalogue();
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
  const rootPath = mkdtempSync(join(tmpdir(), 'moor-agent-options-'));
  t.after(() => rmSync(rootPath, { recursive: true, force: true }));
  f.store.machine.set(['localProject', 'project-a'], { ...ws.projects[0], rootPath });
  f.host.updateCatalogue();
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

function sessionAction(
  f: ReturnType<typeof fixture>,
  action: SessionAction['action'],
  title = '新的合成标题',
): SessionAction {
  return sessionActionSchema.parse({
    operationId: crypto.randomUUID(),
    workspaceId: ws.id,
    sessionId: 'session-a',
    localProjectId: 'project-a',
    expectedRevision: metas(f.meta)['session-session-a']?.metadataRevision ?? 0,
    action,
    ...(action === 'rename' ? { title } : {}),
  });
}

test('session action schema permits only explicit scoped metadata operations', () => {
  const valid = {
    operationId: 'action',
    workspaceId: ws.id,
    sessionId: 'session-a',
    localProjectId: 'project-a',
    expectedRevision: 0,
    action: 'rename',
    title: '  标题  ',
  };
  strict.equal(sessionActionSchema.parse(valid).action, 'rename');
  strict.equal((sessionActionSchema.parse(valid) as { title: string }).title, '标题');
  for (const changes of [
    { title: '   ' },
    { title: 'x'.repeat(201) },
    { title: undefined },
    { localProjectId: undefined },
    { expectedRevision: -1 },
    { expectedRevision: 0.5 },
    { expectedRevision: Number.MAX_SAFE_INTEGER },
    { action: 'delete' },
    { action: 'archive', title: 'not allowed' },
    { command: 'injected' },
    { update: 'injected' },
  ])
    strict.equal(sessionActionSchema.safeParse({ ...valid, ...changes }).success, false);
});

test('session actions preserve transcript, files, native context and lifecycle without an Agent prompt', async (t) => {
  const f = fixture();
  t.after(f.close);
  strict.ok(f.host.workspace.features?.includes('session-actions'));
  await f.host.mutate(request(f));
  await f.started;
  const before = metas(f.meta)['session-session-a'];
  const active = f.host.active.get('session-a');
  await f.host.sessionAction(sessionAction(f, 'rename', '  用户命名  '), 'project-a');
  await f.host.sessionAction(sessionAction(f, 'pin'), 'project-a');
  strict.equal(f.host.active.get('session-a'), active);
  strict.equal(metas(f.meta)['session-session-a'].title, '用户命名');
  strict.equal(metas(f.meta)['session-session-a'].metadataRevision, 2);
  strict.deepEqual(metas(f.meta)['session-session-a'].status, before.status);
  strict.equal(metas(f.meta)['session-session-a'].lastMessageAt, before.lastMessageAt);
  strict.equal(metas(f.meta)['session-session-a'].latestUserMsgId, before.latestUserMsgId);
  await f.finish();
  const withFiles = f.store.doc('session-a'),
    files = mirror(withFiles, 'session-a');
  files.setState((state) => {
    state.history.at(-1)!.fileDiff = {
      files: [{ path: 'synthetic.txt', additions: 1, deletions: 0 }],
    };
    state.history.at(-1)!.items!.push({
      type: 'tool_call',
      toolCallId: 'synthetic-file',
      kind: 'edit',
      content: [{ type: 'diff', path: 'synthetic.txt', oldText: '', newText: 'synthetic' }],
    });
  });
  files.dispose();
  f.store.transaction(() => f.store.persist('session-a', withFiles));
  const snapshot = f.store.journal.db
    .prepare('SELECT snapshot FROM session WHERE id=?')
    .get('session-a')!.snapshot;
  for (const action of ['archive', 'unpin', 'restore'] as const) {
    const result = await f.host.sessionAction(sessionAction(f, action), 'project-a');
    strict.equal(result.accepted, true);
    strict.equal(result.delivered, true);
  }
  strict.equal(metas(f.meta)['session-session-a'].metadataRevision, 5);
  strict.equal(metas(f.meta)['session-session-a'].isArchived, false);
  strict.equal(metas(f.meta)['session-session-a'].isPinned, false);
  strict.deepEqual(
    f.store.journal.db.prepare('SELECT snapshot FROM session WHERE id=?').get('session-a')!
      .snapshot,
    snapshot,
  );
  strict.equal(f.store.nativeSession('session-a'), 'synthetic-native');
  strict.equal(f.dispatches(), 1);
  await f.host.mutate(request(f));
  strict.equal(metas(f.meta)['session-session-a'].title, '用户命名');
  strict.equal(metas(f.meta)['session-session-a'].metadataRevision, 5);
  await f.finish();
});

test('session action receipts survive restart and reject reused operation IDs with a different payload', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'moor-session-actions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'host.sqlite'),
    f = fixture(file);
  await f.host.mutate(request(f));
  await f.finish();
  const rename = sessionAction(f, 'rename');
  const first = await f.host.sessionAction(rename, 'project-a');
  await f.host.sessionAction(sessionAction(f, 'pin'), 'project-a');
  strict.deepEqual(await f.host.sessionAction(rename), first, 'retry returns the original receipt');
  await strict.rejects(
    f.host.sessionAction({ ...rename, title: '不同内容' } as SessionAction),
    /重复编号/,
  );
  f.close();
  const restoredDir = join(dir, 'restored');
  mkdirSync(restoredDir);
  const restoredFile = join(restoredDir, 'host.sqlite');
  copyFileSync(file, restoredFile);
  const restored = new RuntimeStore(restoredFile);
  strict.equal(restored.workspace.id, ws.id);
  strict.equal(restored.workspace.machineId, ws.machineId);
  strict.equal(restored.workspace.userId, ws.userId);
  restored.close();
  const next = fixture(restoredFile);
  t.after(next.close);
  strict.deepEqual(await next.host.sessionAction(rename), first);
  strict.equal(metas(next.meta)['session-session-a'].metadataRevision, 2);
  strict.equal(metas(next.meta)['session-session-a'].isPinned, true);
  strict.equal(next.dispatches(), 0);
  strict.equal(next.store.nativeSession('session-a'), 'synthetic-native');
});

test('session metadata and receipt roll back together when receipt storage fails', async (t) => {
  const f = fixture();
  t.after(f.close);
  await f.host.mutate(request(f));
  await f.finish();
  const action = sessionAction(f, 'rename'),
    before = metas(f.meta),
    persisted = f.store.load('meta');
  f.journal.db.exec(
    "CREATE TRIGGER fail_action BEFORE INSERT ON operation BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END",
  );
  await strict.rejects(f.host.sessionAction(action));
  strict.equal(f.journal.has(action.operationId), false);
  strict.deepEqual(metas(f.meta), before);
  strict.deepEqual(f.store.load('meta'), persisted);
  f.journal.db.exec('DROP TRIGGER fail_action');
  strict.equal((await f.host.sessionAction(action)).meta.metadataRevision, 1);
  strict.equal(f.dispatches(), 1);
});

test('session action scope is validated before receipt lookup and metadata writes', async (t) => {
  const f = fixture();
  t.after(f.close);
  await f.host.mutate(request(f));
  await f.finish();
  const action = sessionAction(f, 'rename');
  for (const changes of [
    { workspaceId: 'wrong-workspace' },
    { localProjectId: 'unknown-project' },
    { sessionId: 'unknown-session' },
  ])
    await strict.rejects(f.host.sessionAction({ ...action, ...changes }));
  await strict.rejects(f.host.sessionAction(action, 'other-project'));
  strict.equal(f.journal.has(action.operationId), false);
  await f.host.sessionAction(action);
  await strict.rejects(f.host.sessionAction(action, 'other-project'));
  for (const field of ['machineId', 'userId']) {
    const original = metas(f.meta)['session-session-a'][field];
    putMeta(f.meta, 'session-session-a', { [field]: 'other-owner' });
    await strict.rejects(f.host.sessionAction(action), /不属于这台电脑/);
    putMeta(f.meta, 'session-session-a', { [field]: original });
  }
  f.host.workspace.projects = [];
  await strict.rejects(f.host.sessionAction(action), /项目副本/);
});

test('concurrent metadata actions serialize, stale revisions conflict and duplicate delivery applies once', async (t) => {
  const f = fixture();
  t.after(f.close);
  await f.host.mutate(request(f));
  await f.finish();
  const rename = sessionAction(f, 'rename'),
    pin = sessionAction(f, 'pin');
  const results = await Promise.allSettled([
    f.host.sessionAction(rename),
    f.host.sessionAction(pin),
  ]);
  strict.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  strict.equal(metas(f.meta)['session-session-a'].metadataRevision, 1);
  strict.equal(f.journal.has(pin.operationId), false);
  const retry = sessionAction(f, 'pin');
  const copies = await Promise.all([f.host.sessionAction(retry), f.host.sessionAction(retry)]);
  strict.deepEqual(copies[0], copies[1]);
  strict.equal(metas(f.meta)['session-session-a'].metadataRevision, 2);
  strict.equal(f.dispatches(), 1);
});

test('archive rejects active or pending turns and archived sessions cannot execute before restore', async (t) => {
  const f = fixture();
  t.after(f.close);
  await f.host.mutate(request(f));
  await f.started;
  const archive = sessionAction(f, 'archive');
  await strict.rejects(f.host.sessionAction(archive), /当前指令/);
  strict.equal(f.journal.has(archive.operationId), false);
  await f.finish();
  const handled = metas(f.meta)['session-session-a'].lastHandledUserMsgId;
  putMeta(f.meta, 'session-session-a', { latestUserMsgId: 'waiting' });
  await strict.rejects(f.host.sessionAction(archive), /当前指令/);
  putMeta(f.meta, 'session-session-a', { latestUserMsgId: handled });
  const turn = request(f);
  const results = await Promise.allSettled([f.host.sessionAction(archive), f.host.mutate(turn)]);
  strict.equal(results[0].status, 'fulfilled');
  strict.equal(results[1].status, 'rejected');
  strict.equal(f.journal.has(turn.operationId), false);
  strict.equal(f.dispatches(), 1);
  await f.host.sessionAction(sessionAction(f, 'restore'));
  await f.host.mutate(turn);
  await f.finish();
  strict.equal(f.dispatches(), 2);
});

test('legacy sessions receive metadata defaults on first action and browser CRDT edits cannot manage metadata', async (t) => {
  const f = fixture();
  t.after(f.close);
  await f.host.mutate(request(f));
  await f.finish();
  const {
    metadataRevision: _revision,
    isPinned: _pinned,
    isArchived: _archived,
    ...legacy
  } = metas(f.meta)['session-session-a'];
  f.store.meta = new Flock();
  putMeta(f.meta, 'session-session-a', legacy);
  f.store.save('meta', f.meta.exportFile());
  const accepted = await f.host.sessionAction(sessionAction(f, 'rename'));
  strict.equal(accepted.meta.metadataRevision, 1);
  strict.equal(accepted.meta.isArchived, false);
  strict.equal(accepted.meta.isPinned, false);
  for (const fields of [
    { title: 'CRDT injected' },
    { isArchived: true },
    { isPinned: true },
    { metadataRevision: 9 },
  ]) {
    const mutation = request(f),
      candidate = Flock.fromFile(f.meta.exportFile()),
      version = candidate.version();
    candidate.importJson(mutation.metaBundle as never);
    putMeta(candidate, 'session-session-a', fields);
    mutation.metaBundle = candidate.exportJson(version);
    await strict.rejects(f.host.mutate(mutation));
    strict.equal(f.journal.has(mutation.operationId), false);
  }
  strict.equal(metas(f.meta)['session-session-a'].metadataRevision, 1);
  strict.equal(f.dispatches(), 1);
});
