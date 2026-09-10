import test from 'node:test';
import strict from 'node:assert/strict';
import { Effect } from 'effect';
import { LocalLoroDataPlaneServer } from '@lody/shared/local-loro-data-plane-server';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { Journal } from '../src/bridge/journal';
import { Store } from '../src/relay/accounts';
import { Flock, LoroDoc, delta, metas, mirror, putMeta, vv } from '../src/model';
import type { Mutation, Workspace } from '../src/protocol';
const ws: Workspace = {
  id: 'lw_synthetic',
  name: '验证工作区',
  userId: 'local:synthetic',
  machineId: 'machine-a',
  projects: [{ id: 'project-a', name: '合成项目', rootPath: '/synthetic/project' }],
  agents: [{ id: 'agent-a', name: '合成 Agent', cliType: 'builtin', agentType: 'codex' }],
};
function fixture() {
  const meta = new Flock(),
    machine = new Flock(),
    docs = new Map<string, LoroDoc>(),
    journal = new Journal(':memory:');
  machine.set(['localProject', 'project-a'], ws.projects[0] as never);
  machine.set(['agentConfig', 'agent-a'], { ...ws.agents[0], machineId: ws.machineId } as never);
  machine.commit();
  const getDoc = (name: string) => {
    let d = docs.get(name);
    if (!d) {
      d = new LoroDoc();
      docs.set(name, d);
    }
    return d;
  };
  const engine = new LocalLoroDataPlaneServer({
    workspaceId: ws.id,
    resolveDoc: async (id) => getDoc(id),
    resolveMetaFlock: async () => meta,
    resolveFlockDoc: async () => machine,
  });
  const messages = new Set<(v: any) => void>(),
    statuses = new Set<(v: boolean) => void>();
  let connected = true,
    chain = Promise.resolve(),
    dispatches = 0;
  let gate: ((m: any) => Promise<void>) | undefined;
  function pauseDocJoin(ordinal: number) {
    let seen = 0,
      reach!: () => void,
      resume!: () => void;
    const reached = new Promise<void>((r) => (reach = r)),
      waiting = new Promise<void>((r) => (resume = r));
    gate = async (m) => {
      if (m.type === 'join' && m.room.scope === 'doc' && ++seen === ordinal) {
        reach();
        await waiting;
      }
    };
    return { reached, resume };
  }
  const connection = {
    id: 'synthetic-local-socket',
    send: (m: any) => {
      for (const f of messages) f(m);
    },
  };
  const link = {
    isConnected: () => connected,
    onStatusChange: (f: (v: boolean) => void) => {
      statuses.add(f);
      return () => {
        statuses.delete(f);
      };
    },
    onMessage: (f: (v: any) => void) => {
      messages.add(f);
      return () => {
        messages.delete(f);
      };
    },
    send: (m: any) => {
      chain = chain.then(async () => {
        await gate?.(m);
        if (connected) await engine.handleMessage(connection, m);
      });
    },
  };
  const control = {
    machineRpc: (m: any) =>
      Effect.sync(() => {
        dispatches++;
        const view = mirror(getDoc('session-' + m.params.sessionId), m.params.sessionId);
        strict.ok(
          view.getState().history.some((t) => t.id === m.params.userTurnId),
          'daemon must receive the actual browser-authored turn before ACK',
        );
        view.dispose();
        strict.equal(
          metas(meta)['session-' + m.params.sessionId].latestUserMsgId,
          m.params.userTurnId,
        );
        return {
          ok: true,
          result: {
            type: 'session/dispatch-turn_response',
            sessionId: m.params.sessionId,
            userTurnId: m.params.userTurnId,
            accepted: true,
            disposition: 'accepted',
          },
        };
      }),
  };
  const host = new HostWorkspace(
    structuredClone(ws),
    link,
    control as never,
    journal,
    () => {},
    () => {},
  );
  return {
    host,
    meta,
    machine,
    getDoc,
    journal,
    pauseDocJoin,
    dispatches: () => dispatches,
    flush: () => chain,
    disconnect: () => {
      connected = false;
      for (const f of statuses) f(false);
    },
    reconnect: () => {
      connected = true;
      for (const f of statuses) f(true);
    },
    close: () => {
      host.close();
      engine.dispose();
      journal.close();
    },
  };
}
function request(f: ReturnType<typeof fixture>, sessionId = 'session-a') {
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
test('relay database contains only account and device records, never session bodies', async (t) => {
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
    ['account', 'device', 'login', 'pair'],
  );
  strict.equal(store.device(owner, device.id).catalog, '[]');
  strict.throws(() => store.device('another-account', device.id));
  store.revoke(owner, device.id);
  strict.throws(() => store.deviceToken(device.token));
});
test('delivery waits for real local IPC v7 reconciliation and daemon dispatch ACK', async (t) => {
  const f = fixture();
  t.after(f.close);
  await f.host.ready();
  const m = request(f);
  const accepted = await f.host.mutate(m);
  strict.equal(accepted.delivered, true);
  strict.equal(
    metas(f.meta)['session-' + m.sessionId].latestUserMsgId,
    f.journal.lookup(ws.id, m).turn_id,
  );
  const snapshot = await f.host.read(m.sessionId);
  strict.equal(snapshot.online, true);
  strict.ok(snapshot.update);
});
test('same request recovers a lost relay response without creating another turn', async (t) => {
  const f = fixture();
  t.after(f.close);
  await f.host.ready();
  const m = request(f),
    first = await f.host.mutate(m);
  strict.deepEqual(await f.host.mutate(m), first);
  const view = mirror(f.getDoc('session-' + m.sessionId), m.sessionId);
  strict.equal(view.getState().history.length, 1);
  view.dispose();
  await strict.rejects(() => f.host.mutate({ ...m, sessionId: 'different-session' }));
});
test('two clients race at the host; stale/offline turns do not dispatch', async (t) => {
  const f = fixture();
  t.after(f.close);
  await f.host.ready();
  const a = request(f),
    b = request(f);
  const results = await Promise.allSettled([f.host.mutate(a), f.host.mutate(b)]);
  strict.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  f.disconnect();
  await strict.rejects(() => f.host.mutate(request(f, 'offline-session')));
  strict.equal(metas(f.meta)['session-offline-session'], undefined);
});
test('session room subscriptions exist only while requested or watched', async (t) => {
  const f = fixture();
  t.after(f.close);
  await f.host.ready();
  const m = request(f);
  await f.host.mutate(m);
  strict.equal(f.host.docs.size, 0);
  await f.host.watch(m.sessionId, true);
  strict.equal(f.host.docs.size, 1);
  await f.host.read(m.sessionId);
  strict.equal(f.host.docs.size, 1);
  await f.host.watch(m.sessionId, false);
  strict.equal(f.host.docs.size, 0);
});

test('disconnect during initial read rejects immediately and cannot dispatch on reconnect', async (t) => {
  const f = fixture();
  t.after(f.close);
  await f.host.ready();
  const gate = f.pauseDocJoin(1),
    m = request(f),
    pending = f.host.mutate(m);
  await gate.reached;
  f.disconnect();
  await strict.rejects(pending);
  f.reconnect();
  gate.resume();
  await f.flush();
  strict.equal(f.dispatches(), 0);
  strict.equal(f.journal.lookup(ws.id, m), undefined);
  strict.equal(f.host.docs.size, 0);
});
test('disconnect after staging preserves the request id but never auto dispatches', async (t) => {
  const f = fixture();
  t.after(f.close);
  await f.host.ready();
  const gate = f.pauseDocJoin(2),
    m = request(f),
    pending = f.host.mutate(m);
  await gate.reached;
  f.disconnect();
  await strict.rejects(pending, (e: any) => e.status === 504);
  f.reconnect();
  gate.resume();
  await f.flush();
  strict.equal(f.dispatches(), 0);
  strict.equal(f.journal.lookup(ws.id, m).phase, 'staged');
  strict.equal(f.host.docs.size, 0);
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
test('approval is bound to its active request; competing and late choices are rejected', async (t) => {
  const f = fixture();
  t.after(f.close);
  await f.host.ready();
  const m = request(f);
  await f.host.mutate(m);
  const host = f.getDoc('session-' + m.sessionId),
    view = mirror(host, m.sessionId);
  view.setState(
    (s: any) =>
      void s.history.push({
        id: 'assistant-1',
        role: 'assistant',
        timestamp: '2026-01-01T00:00:01Z',
        finished: false,
        items: [
          {
            type: 'tool_call',
            toolCallId: 'tool-1',
            title: 'Synthetic edit',
            status: 'pending',
            kind: 'edit',
            permissionRequest: {
              requestId: 'permission-1',
              options: [
                { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
                { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
              ],
            },
          },
        ],
        fileDiff: null,
      }),
  );
  view.dispose();
  host.commit();
  function choice(optionId: string) {
    const d = new LoroDoc();
    d.import(host.export({ mode: 'snapshot' }));
    const before = vv(d),
      v = mirror(d, m.sessionId);
    v.setState((s: any) => {
      s.history[1].items[0].permissionRequest.outcome = { outcome: 'selected', optionId };
    });
    v.dispose();
    d.commit();
    return {
      ...m,
      operationId: crypto.randomUUID(),
      kind: 'permission' as const,
      expectedTurnId: f.journal.lookup(ws.id, m).turn_id,
      requestId: 'permission-1',
      update: delta(d, before),
      metaBundle: undefined,
    };
  }
  const allow = choice('allow'),
    deny = choice('deny');
  const accepted = await f.host.mutate(allow);
  strict.equal(accepted.delivered, true);
  await strict.rejects(() => f.host.mutate(deny));
  strict.deepEqual(await f.host.mutate(allow), accepted);
  strict.equal(f.dispatches(), 1, 'an approval never starts a new Agent turn');
});
