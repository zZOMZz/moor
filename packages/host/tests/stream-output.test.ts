import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoroDoc, LoroList, LoroMap, mirror, putMeta } from '@moor/session/model';
import { appendSessionText } from '@moor/session/session-output';
import {
  buildSessionPermission,
  buildSessionTurn,
  readClientSession,
  sessionPermissionReviews,
} from '@moor/session/session-operations';
import { validateMutation } from '../src/commands/validate-mutation';
import { RuntimeStore } from '../src/persistence/store';
import { HostWorkspace } from '../src/sessions/workspace';
import { safeAgentMetadata } from '../src/agents/attachments';
import { searchHostSessions } from '../src/sessions/search';

function fixture(
  t: TestContext,
  options: {
    checkpoint?: { updates: number; bytes: number };
    legacyText?: string;
    history?: string;
  } = {},
) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moor-stream-output-'))),
    rootPath = join(directory, 'project'),
    file = join(directory, 'runtime.sqlite');
  mkdirSync(rootPath);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new RuntimeStore(file, { outputCheckpoint: options.checkpoint });
  const scope = {
    workspaceId: store.workspace.id,
    userId: store.workspace.userId,
    machineId: store.workspace.machineId,
    localProjectId: 'project-a',
    sessionId: 'session-a',
  };
  const agent = {
    id: 'agent-a',
    name: 'Synthetic',
    cliType: 'builtin',
    agentType: 'codex',
    machineId: scope.machineId,
    runtimeOverrides: { codexPath: process.execPath },
  };
  store.machine.set(['localProject', scope.localProjectId], {
    id: scope.localProjectId,
    name: 'Fixture',
    rootPath,
  });
  store.machine.set(['agentConfig', agent.id], agent);
  store.saveMachine();
  store.reserveAttachmentScope(scope);
  store.agents.bind(scope, agent);
  putMeta(store.meta, 'session-' + scope.sessionId, {
    id: scope.sessionId,
    userId: scope.userId,
    machineId: scope.machineId,
    project: { kind: 'local', localProjectId: scope.localProjectId },
    agentConfigId: agent.id,
    agentType: agent.agentType,
    cliType: agent.cliType,
    latestUserMsgId: 'user-a',
    lastHandledUserMsgId: 'user-a',
    status: { type: 'working' },
  });
  const doc = new LoroDoc();
  doc.setPeerId('1');
  const view = mirror(doc, scope.sessionId);
  view.setState((state) => {
    state.session.id = scope.sessionId;
    const turn = (id: string, finished: boolean, text?: string) => ({
      id,
      userTurnId: 'user-a',
      role: 'assistant' as const,
      timestamp: '2026-01-01T00:00:00.000Z',
      userId: undefined,
      read: undefined,
      inputConfig: undefined,
      finished,
      status: finished ? 'handled' : undefined,
      items: text === undefined ? [] : [{ type: 'text', text }],
      fileDiff: null,
    });
    if (options.history) state.history.push(turn('old-turn', true, options.history));
    state.history.push(turn('assistant-a', false, options.legacyText));
  });
  view.dispose();
  store.persist(scope.sessionId, doc);
  let published = 0,
    opened = 0,
    closed = false;
  const host = new HostWorkspace(
    store,
    {
      async open() {
        opened++;
        throw Error('Synthetic output tests must never dispatch');
      },
    },
    () => {},
    () => {
      published++;
    },
  );
  const run: Parameters<HostWorkspace['update']>[1] = {
    turnId: 'assistant-a',
    userTurnId: 'user-a',
    doc,
    stopped: false,
    projectScope: scope,
    rootPath,
    snapshotIssues: [],
    agent,
    execution: {
      ...scope,
      rootPath,
      projectRoot: rootPath,
      executionId: 'shared',
      executionRevision: 0,
    },
    permissions: new Map(),
  };
  host.active.set(scope.sessionId, run);
  const close = () => {
    if (closed) return;
    closed = true;
    host.active.clear();
    host.close();
    store.close();
  };
  t.after(close);
  return {
    host,
    store,
    run,
    scope,
    file,
    close,
    published: () => published,
    opened: () => opened,
    tool(patch: Record<string, unknown> = {}) {
      host.update(scope.sessionId, run, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-a',
        ...patch,
      });
    },
    emit(text: string, type: 'text' | 'thought' = 'text') {
      host.update(scope.sessionId, run, {
        sessionUpdate: type === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk',
        content: { type: 'text', text },
      });
    },
  };
}
function read(doc: LoroDoc) {
  const view = mirror(doc, 'session-a');
  try {
    return structuredClone(view.getState());
  } finally {
    view.dispose();
  }
}
function durable(f: ReturnType<typeof fixture>) {
  const doc = f.store.doc(f.scope.sessionId);
  try {
    return { state: read(doc), version: Buffer.from(doc.version().encode()) };
  } finally {
    doc.free();
  }
}
function count(f: ReturnType<typeof fixture>, table: string) {
  return Number(f.store.journal.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count);
}
function content(length: number) {
  let seed = 123456789;
  return Array.from({ length }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return String.fromCharCode(32 + ((seed >>> 16) % 95));
  }).join('');
}

test('100 streamed chunks persist actual additions without exporting snapshots or rewriting metadata', (t) => {
  const f = fixture(t, { history: content(100000) }),
    initial = f.store.searchSource(f.scope.sessionId)!,
    oldPeer = f.run.doc.peerIdStr,
    oldVectorBytes = f.run.doc.version().encode().length,
    output = content(10000);
  f.store.journal.db.exec(`
    CREATE TRIGGER reject_stream_snapshot BEFORE INSERT ON session BEGIN SELECT RAISE(ABORT,'unexpected snapshot'); END;
    CREATE TRIGGER reject_stream_meta BEFORE INSERT ON runtime_state WHEN NEW.key='meta' BEGIN SELECT RAISE(ABORT,'unexpected metadata'); END;
  `);
  const originalExport = LoroDoc.prototype.export;
  let snapshots = 0;
  t.mock.method(
    LoroDoc.prototype,
    'export',
    function (this: LoroDoc, mode: Parameters<LoroDoc['export']>[0]) {
      if (mode.mode === 'snapshot') snapshots++;
      return originalExport.call(this, mode);
    },
  );
  for (let i = 0; i < 100; i++) f.emit(output.slice(i * 100, (i + 1) * 100));
  assert.equal(snapshots, 0);
  assert.equal(count(f, 'session_delta'), 100);
  const bytes = Number(
    f.store.journal.db
      .prepare('SELECT SUM(length(update_bytes)) AS bytes FROM session_delta')
      .get()!.bytes,
  );
  assert(bytes < 30000, `Expected payload-sized additions, received ${bytes} bytes`);
  assert.equal(f.run.doc.peerIdStr, oldPeer);
  assert(f.run.doc.version().encode().length <= oldVectorBytes + 4);
  assert.equal((read(f.run.doc).history.at(-1)!.items![0] as { text: string }).text, output);
  assert.deepEqual(durable(f).version, Buffer.from(f.run.doc.version().encode()));
  assert.equal(f.store.searchSource(f.scope.sessionId)!.revision, initial.revision + 100);
  assert.equal(f.store.searchSource(f.scope.sessionId)!.bytes, initial.bytes + bytes);
  assert.equal(count(f, 'session_recovery'), 1);
  assert.equal(f.opened(), 0);
});

test('tool creation and 100 updates persist deltas without snapshots or metadata rewrites', (t) => {
  const f = fixture(t, { history: content(100000) });
  const source = f.store.searchSource(f.scope.sessionId)!;
  f.store.journal.db.exec(`
    CREATE TRIGGER reject_tool_snapshot BEFORE INSERT ON session BEGIN SELECT RAISE(ABORT,'unexpected snapshot'); END;
    CREATE TRIGGER reject_tool_meta BEFORE INSERT ON runtime_state WHEN NEW.key='meta' BEGIN SELECT RAISE(ABORT,'unexpected metadata'); END;
  `);
  const originalExport = LoroDoc.prototype.export;
  let snapshots = 0;
  t.mock.method(
    LoroDoc.prototype,
    'export',
    function (this: LoroDoc, mode: Parameters<LoroDoc['export']>[0]) {
      if (mode.mode === 'snapshot') snapshots++;
      return originalExport.call(this, mode);
    },
  );
  let subscriptions = 0;
  const originalSubscribe = LoroDoc.prototype.subscribe;
  const subscribe = t.mock.method(
    LoroDoc.prototype,
    'subscribe',
    function (this: LoroDoc, listener: Parameters<LoroDoc['subscribe']>[0]) {
      subscriptions++;
      return originalSubscribe.call(this, listener);
    },
  );
  f.tool({
    sessionUpdate: 'tool_call',
    title: 'Synthetic tool',
    status: 'in_progress',
    rawInput: { command: 'synthetic-only' },
  });
  const detail = 'unchanged tool detail '.repeat(200);
  for (let sequence = 0; sequence < 100; sequence++) f.tool({ rawOutput: { sequence, detail } });
  assert.equal(snapshots, 0);
  assert.equal(subscriptions, 0, 'tool deltas do not construct document-wide Mirror subscriptions');
  subscribe.mock.restore();
  assert.equal(count(f, 'session_delta'), 101);
  assert.equal(f.store.searchSource(f.scope.sessionId)!.revision, source.revision + 101);
  assert.equal(count(f, 'session_recovery'), 1);
  const tool = durable(f).state.history.at(-1)!.items![0] as any;
  assert.equal(tool.title, 'Synthetic tool');
  assert.deepEqual(tool.rawInput, { command: 'synthetic-only' });
  assert.deepEqual(tool.rawOutput, { sequence: 99, detail });
  const deltaBytes = Number(
    f.store.journal.db
      .prepare('SELECT SUM(length(update_bytes)) AS bytes FROM session_delta')
      .get()!.bytes,
  );
  assert(
    deltaBytes < 100000,
    `unchanged tool detail must not be retransmitted on every sequence: ${deltaBytes}`,
  );
  assert.deepEqual(durable(f).version, Buffer.from(f.run.doc.version().encode()));
  assert.equal(f.published(), 101);
  assert.equal(f.opened(), 0);
});

for (const representation of ['containers', 'json-item', 'json-list'] as const)
  test(`direct tool edits preserve the legacy Mirror result for ${representation}`, (t) => {
    const f = fixture(t, { history: 'settled history must remain untouched' });
    const originalItems = [
      {
        type: 'tool_call',
        toolCallId: 'tool-a',
        title: 'earlier duplicate',
        rawOutput: { first: true },
      },
      { type: 'text', text: 'between tools' },
      {
        type: 'tool_call',
        toolCallId: 'tool-a',
        title: 'last duplicate',
        kind: 'execute',
        status: 'pending',
        rawInput: { remove: true, nested: { old: true } },
        rawOutput: { old: true },
        content: [{ type: 'content', content: { type: 'text', text: 'old detail' } }],
        permissionRequest: { requestId: 'request-a', options: [] },
        future: { keep: ['unknown', { value: 7 }] },
      },
      { type: 'tool_call', toolCallId: 'other-tool', rawOutput: { untouched: true } },
    ];
    const history = f.run.doc.getList('history');
    const turn = history.get(history.length - 1) as LoroMap;
    const settledId = (history.get(0) as LoroMap).id;
    if (representation === 'containers') {
      const seed = mirror(f.run.doc, f.scope.sessionId);
      seed.setState((state) => {
        state.history.at(-1)!.items = structuredClone(originalItems);
      });
      seed.dispose();
    } else if (representation === 'json-list') turn.set('items', originalItems);
    else {
      const items = turn.setContainer('items', new LoroList());
      for (const item of originalItems) items.push(item);
    }
    f.store.persist(f.scope.sessionId, f.run.doc);
    const oracleDoc = f.run.doc.fork();
    const oracle = mirror(oracleDoc, f.scope.sessionId);
    t.after(() => {
      oracle.dispose();
      oracleDoc.free();
    });
    let toolContainer: string | undefined;
    for (const patch of [
      { status: 'in_progress' },
      { rawInput: { replacement: ['中文', null] }, rawOutput: null, content: [] },
      {
        title: '',
        kind: null,
        status: 'completed',
        rawInput: [],
        rawOutput: { final: { objects: [true, 1, null] } },
      },
      { rawOutput: [undefined, 'tail'] },
      { rawOutput: [undefined] },
      { rawInput: undefined, rawOutput: undefined, content: undefined },
    ] as Record<string, unknown>[]) {
      // The former host path is the semantic oracle: last matching ID, replace
      // provided fields in full, retain omitted and unknown fields.
      oracle.setState((state) => {
        const tool: any = state.history
          .at(-1)!
          .items!.findLast(
            (item: any) => item.type === 'tool_call' && item.toolCallId === 'tool-a',
          );
        for (const key of ['title', 'kind', 'status'])
          if (patch[key] !== undefined) tool[key] = patch[key];
        if (patch.content !== undefined) tool.content = patch.content;
        for (const key of ['rawInput', 'rawOutput'])
          if (patch[key] !== undefined) tool[key] = safeAgentMetadata(patch[key]);
      });
      f.tool(patch);
      assert.deepEqual(read(f.run.doc), read(oracleDoc));
      const currentHistory = f.run.doc.getList('history');
      assert.equal((currentHistory.get(0) as LoroMap).id, settledId);
      const currentItems = (currentHistory.get(currentHistory.length - 1) as LoroMap).get(
        'items',
      ) as LoroList;
      const currentTool = currentItems.get(2) as LoroMap;
      assert.ok(currentTool instanceof LoroMap);
      if (toolContainer)
        assert.equal(
          currentTool.id,
          toolContainer,
          'later patches retain the promoted tool container',
        );
      toolContainer = currentTool.id;
    }
    f.host.edit(f.scope.sessionId, f.run, (turn) => {
      turn.items[2].future.keep.push('generic edit');
    });
    const items = durable(f).state.history.at(-1)!.items as any[];
    assert.deepEqual(items[0], originalItems[0]);
    assert.deepEqual(items[3], originalItems[3]);
    assert.deepEqual(items[2].future.keep, ['unknown', { value: 7 }, 'generic edit']);
    assert.deepEqual(items[2].permissionRequest, originalItems[2]!.permissionRequest);
  });

for (const fault of ['delta', 'checkpoint'] as const)
  test(`tool ${fault} failure rolls embedded attachments and document output back before publication`, (t) => {
    const f = fixture(t, {
      checkpoint: { updates: fault === 'checkpoint' ? 1 : 512, bytes: 1024 * 1024 },
    });
    const before = durable(f),
      source = f.store.searchSource(f.scope.sessionId),
      published = f.published();
    const metadata = Buffer.from(f.store.load('meta')!);
    const update = {
      sessionUpdate: 'tool_call',
      title: 'attachment output',
      content: [
        {
          type: 'content',
          content: {
            type: 'resource',
            resource: {
              uri: 'file:///synthetic.txt',
              text: 'synthetic attachment',
              mimeType: 'text/plain',
            },
          },
        },
      ],
    };
    f.store.journal.db.exec(
      `CREATE TRIGGER reject_tool_output BEFORE INSERT ON ${fault === 'delta' ? 'session_delta' : 'session'} BEGIN SELECT RAISE(ABORT,'synthetic tool failure'); END`,
    );
    assert.throws(() => f.tool(update), /synthetic tool failure/);
    assert.deepEqual(durable(f), before);
    assert.deepEqual(Buffer.from(f.run.doc.version().encode()), before.version);
    assert.deepEqual(f.store.searchSource(f.scope.sessionId), source);
    assert.deepEqual(Buffer.from(f.store.load('meta')!), metadata);
    assert.equal(count(f, 'attachment'), 0);
    assert.equal(f.published(), published);
    f.store.journal.db.exec('DROP TRIGGER reject_tool_output');
    f.tool(update);
    const tool = durable(f).state.history.at(-1)!.items![0] as any;
    assert.equal(tool.content[0].content.type, 'attachment');
    assert.equal(count(f, 'attachment'), 1);
    assert.equal(f.published(), published + 1);
  });

test('tool compaction and restart retain final detail, exact attachment references and old client history', (t) => {
  const f = fixture(t, { checkpoint: { updates: 3, bytes: 1024 * 1024 } });
  const cached = f.run.doc.fork();
  t.after(() => cached.free());
  f.tool({ sessionUpdate: 'tool_call', title: 'Saved tool', status: 'pending' });
  f.tool({ status: 'in_progress', rawOutput: { sequence: 1 } });
  f.tool({ rawOutput: { sequence: 2 } });
  assert.equal(count(f, 'session_delta'), 0, 'the existing threshold still checkpoints');
  f.tool({
    status: 'completed',
    rawOutput: { sequence: 3 },
    content: [
      {
        type: 'content',
        content: {
          type: 'resource',
          resource: {
            uri: 'file:///result.txt',
            text: 'saved final tool artifact',
            mimeType: 'text/plain',
          },
        },
      },
    ],
  });
  assert.equal(count(f, 'session_delta'), 1);
  const before = durable(f).state.history.at(-1)!.items![0];
  f.close();
  const restored = new RuntimeStore(f.file);
  t.after(() => restored.close());
  const doc = restored.doc(f.scope.sessionId);
  t.after(() => doc.free());
  cached.import(doc.export({ mode: 'update', from: cached.version() }));
  assert.deepEqual(read(cached), read(doc));
  assert.deepEqual(read(doc).history.at(-1)!.items![0], before);
  assert.equal(
    restored.journal.db.prepare('SELECT COUNT(*) AS count FROM attachment').get()!.count,
    1,
  );
  assert.equal(
    read(doc).history.at(-1)!.status,
    'failed',
    'startup still settles the unfinished assistant',
  );
  assert.equal(f.opened(), 0);
});

test('checkpoint and restart retain old client version vectors, scalar history and Unicode chunk order', (t) => {
  const f = fixture(t, {
    checkpoint: { updates: 3, bytes: 1024 * 1024 },
    history: 'legacy finished scalar',
  });
  const cached = f.run.doc.fork(),
    initialPeer = f.run.doc.peerIdStr;
  t.after(() => cached.free());
  f.emit('中文🙂');
  const intermediate = f.run.doc.fork();
  t.after(() => intermediate.free());
  f.emit(' combining e\u0301');
  f.emit(' final');
  assert.equal(count(f, 'session_delta'), 0);
  assert.equal(f.run.doc.peerIdStr, initialPeer);
  for (const client of [cached, intermediate]) {
    const update = f.run.doc.export({ mode: 'update', from: client.version() });
    assert.equal(client.import(update).pending?.size ?? 0, 0);
    assert.deepEqual(read(client), read(f.run.doc));
  }
  f.emit('思考', 'thought');
  f.emit('再思考', 'thought');
  assert.equal(count(f, 'session_delta'), 2);
  f.close();
  const restored = new RuntimeStore(f.file);
  t.after(() => restored.close());
  const doc = restored.doc(f.scope.sessionId);
  t.after(() => doc.free());
  cached.import(doc.export({ mode: 'update', from: cached.version() }));
  assert.deepEqual(read(cached), read(doc));
  assert.deepEqual(Buffer.from(cached.version().encode()), Buffer.from(doc.version().encode()));
  const state = read(doc);
  assert.equal((state.history[0].items![0] as { text: string }).text, 'legacy finished scalar');
  assert.equal(
    (state.history.at(-1)!.items![0] as { text: string }).text,
    '中文🙂 combining e\u0301 final',
  );
  assert.equal((state.history.at(-1)!.items![1] as { text: string }).text, '思考再思考');
  assert.equal(state.history.at(-1)!.status, 'failed');
  assert.equal(
    restored.journal.db.prepare('SELECT COUNT(*) AS count FROM session_delta').get()!.count,
    0,
  );
  assert.equal(
    restored.journal.db.prepare('SELECT COUNT(*) AS count FROM session_recovery').get()!.count,
    0,
  );
  assert.equal(f.opened(), 0);
});

for (const fault of ['delta', 'search', 'recovery', 'checkpoint', 'tail-delete'] as const)
  test(`stream ${fault} failure rolls back content, indexes and memory before publication`, (t) => {
    const f = fixture(t, {
      checkpoint: {
        updates: fault === 'checkpoint' ? 1 : fault === 'tail-delete' ? 2 : 512,
        bytes: 1024 * 1024,
      },
    });
    if (fault === 'tail-delete') f.emit('saved');
    const before = durable(f),
      source = f.store.searchSource(f.scope.sessionId),
      deltas = count(f, 'session_delta'),
      recovery = count(f, 'session_recovery'),
      published = f.published();
    const target = {
      delta: 'BEFORE INSERT ON session_delta',
      search: 'BEFORE UPDATE ON search_source',
      recovery: 'BEFORE INSERT ON session_recovery',
      checkpoint: 'BEFORE INSERT ON session',
      'tail-delete': 'BEFORE DELETE ON session_delta',
    }[fault];
    f.store.journal.db.exec(
      `CREATE TRIGGER synthetic_output_failure ${target} BEGIN SELECT RAISE(ABORT,'synthetic output failure'); END`,
    );
    assert.throws(() => f.emit('retry-once'), /synthetic output failure/);
    assert.deepEqual(durable(f), before);
    assert.deepEqual(Buffer.from(f.run.doc.version().encode()), before.version);
    assert.deepEqual(f.store.searchSource(f.scope.sessionId), source);
    assert.equal(count(f, 'session_delta'), deltas);
    assert.equal(count(f, 'session_recovery'), recovery);
    assert.equal(f.published(), published);
    f.store.journal.db.exec('DROP TRIGGER synthetic_output_failure');
    f.emit('retry-once');
    assert.equal(
      (durable(f).state.history.at(-1)!.items![0] as { text: string }).text,
      (fault === 'tail-delete' ? 'saved' : '') + 'retry-once',
    );
  });

test('stale output cannot replace a newer durable tail and delta corruption cannot silently truncate history', (t) => {
  const f = fixture(t),
    stale = f.run.doc.fork(),
    from = f.run.doc.version();
  t.after(() => stale.free());
  stale.setPeerId(f.run.doc.peerIdStr);
  appendSessionText(stale, f.scope.sessionId, f.run.turnId, 'text', 'stale');
  f.emit('current');
  const before = durable(f);
  assert.throws(() => f.store.persistOutput(f.scope.sessionId, stale, from), /持久会话已更新/);
  const older = new LoroDoc();
  const checkpoint = f.store.journal.db
    .prepare('SELECT snapshot FROM session WHERE id=?')
    .get(f.scope.sessionId)!;
  older.import(checkpoint.snapshot as Uint8Array);
  assert.throws(() => f.store.persist(f.scope.sessionId, older), /检查点原持久版本/);
  older.free();
  assert.deepEqual(durable(f), before);
  f.store.journal.db.prepare('UPDATE session_delta SET version=?').run(new Uint8Array([1, 2, 3]));
  assert.throws(() => f.store.doc(f.scope.sessionId), /增量不完整或版本不匹配/);
});

test('byte thresholds compact complete output and advancing another session cannot consume its tail', (t) => {
  const f = fixture(t, { checkpoint: { updates: 512, bytes: 1024 } });
  f.emit('small');
  assert.equal(count(f, 'session_delta'), 1);
  f.emit(content(2000));
  assert.equal(count(f, 'session_delta'), 0);
  assert.equal(
    (durable(f).state.history[0].items![0] as { text: string }).text,
    'small' + content(2000),
  );
  const from = f.run.doc.version();
  assert.throws(
    () => f.store.persistOutput('another-session', f.run.doc, from),
    /输出会话身份不匹配/,
  );
  from.free();
  assert.equal(f.store.doc('another-session').getList('history').length, 0);
});

test('text promotion preserves legacy live strings and stopped or closed callbacks cannot append', (t) => {
  const f = fixture(t, { legacyText: 'legacy prefix' });
  f.emit(' plus new');
  assert.equal(
    (durable(f).state.history[0].items![0] as { text: string }).text,
    'legacy prefix plus new',
  );
  const source = f.store.searchSource(f.scope.sessionId),
    published = f.published();
  f.run.stopped = true;
  f.emit(' late stopped');
  f.run.stopped = false;
  f.host.closed = true;
  f.emit(' late closed');
  assert.deepEqual(f.store.searchSource(f.scope.sessionId), source);
  assert.equal(f.published(), published);
});

test('committed output survives a failure before publication and cannot be overwritten by stale memory', (t) => {
  const f = fixture(t),
    save = f.store.persistOutput.bind(f.store),
    published = f.published();
  t.mock.method(f.store, 'persistOutput', (...args: Parameters<RuntimeStore['persistOutput']>) => {
    save(...args);
    throw Error('synthetic failure after commit');
  });
  assert.throws(() => f.emit('committed before publication'), /failure after commit/);
  assert.equal(f.published(), published);
  assert.equal(
    (durable(f).state.history[0].items![0] as { text: string }).text,
    'committed before publication',
  );
  assert.throws(() => f.store.persist(f.scope.sessionId, f.run.doc), /检查点原持久版本/);
  f.close();
  const restored = new RuntimeStore(f.file);
  t.after(() => restored.close());
  const doc = restored.doc(f.scope.sessionId);
  t.after(() => doc.free());
  assert.equal(
    (read(doc).history[0].items![0] as { text: string }).text,
    'committed before publication',
  );
  assert.equal(read(doc).history[0].status, 'failed');
  assert.equal(f.opened(), 0);
});

for (const storage of ['tail', 'checkpoint', 'legacy-snapshot'] as const)
  test(`post-commit output cannot be replaced by a longer same-peer terminal branch (${storage})`, (t) => {
    const f = fixture(t, {
      checkpoint: { updates: storage === 'tail' ? 512 : 1, bytes: 1024 * 1024 },
    });
    const save = f.store.persistOutput.bind(f.store);
    t.mock.method(
      f.store,
      'persistOutput',
      (...args: Parameters<RuntimeStore['persistOutput']>) => {
        save(...args);
        if (storage === 'legacy-snapshot')
          f.store.journal.db
            .prepare('DELETE FROM session_checkpoint WHERE session_id=?')
            .run(f.scope.sessionId);
        throw Error('synthetic failure after commit before publication');
      },
    );
    assert.throws(() => f.emit('x'), /failure after commit/);
    const before = durable(f),
      source = f.store.searchSource(f.scope.sessionId),
      published = f.published();
    const terminal = (turn: any) => {
      turn.finished = true;
      turn.status = 'failed';
      turn.items.push({ type: 'system_notice', name: 'chat_failed', message: 'Synthetic failure' });
    };
    // A larger counter on the same peer is not proof that this branch contains
    // the committed text. This is the case a dominance-only guard accepted.
    const competing = f.run.doc.fork();
    competing.setPeerId(f.run.doc.peerIdStr);
    const view = mirror(competing, f.scope.sessionId);
    view.setState((state) => terminal(state.history.at(-1)));
    view.dispose();
    const committed = f.store.doc(f.scope.sessionId),
      actual = committed.version(),
      next = competing.version();
    assert((next.compare(actual) ?? -1) >= 0);
    actual.free();
    next.free();
    committed.free();
    competing.free();

    assert.throws(() => f.host.edit(f.scope.sessionId, f.run, terminal, true), /检查点原持久版本/);
    assert.deepEqual(durable(f), before);
    assert.deepEqual(f.store.searchSource(f.scope.sessionId), source);
    assert.equal(f.published(), published);
    assert.equal(count(f, 'session_delta'), storage === 'tail' ? 1 : 0);
    f.close();
    const restarted = new RuntimeStore(f.file);
    const restored = restarted.doc(f.scope.sessionId);
    assert.equal((read(restored).history.at(-1)!.items![0] as { text: string }).text, 'x');
    assert.equal(read(restored).history.at(-1)!.status, 'failed');
    const recovered = read(restored);
    restored.free();
    restarted.close();
    const reopened = new RuntimeStore(f.file);
    const reread = reopened.doc(f.scope.sessionId);
    assert.deepEqual(
      read(reread),
      recovered,
      'a second restart does not replay output or recovery',
    );
    reread.free();
    reopened.close();
    assert.equal(f.opened(), 0);
  });

test('a document read before a later checkpoint retains its original CAS base, and rollback never advances it', (t) => {
  const f = fixture(t, { checkpoint: { updates: 1, bytes: 1024 * 1024 } });
  const old = f.store.doc(f.scope.sessionId);
  t.after(() => old.free());
  f.emit('new durable checkpoint');
  const view = mirror(old, f.scope.sessionId);
  view.setState((state) => {
    state.history.at(-1)!.status = 'failed';
  });
  view.dispose();
  assert.throws(() => f.store.persist(f.scope.sessionId, old), /检查点原持久版本/);

  const current = f.store.doc(f.scope.sessionId);
  t.after(() => current.free());
  const currentView = mirror(current, f.scope.sessionId);
  currentView.setState((state) => {
    state.history.at(-1)!.status = 'working';
  });
  currentView.dispose();
  assert.throws(
    () =>
      f.store.transaction(() => {
        f.store.persist(f.scope.sessionId, current);
        throw Error('synthetic outer transaction rollback');
      }),
    /outer transaction rollback/,
  );
  f.store.persist(f.scope.sessionId, current);
  assert.equal(durable(f).state.history.at(-1)!.status, 'working');
});

for (const kind of ['text', 'tool'] as const)
  for (const change of ['owner', 'project', 'metadata', 'active-turn'] as const)
    test(`${kind} output preserves scope checks after ${change} replacement`, (t) => {
      const f = fixture(t);
      const emit = (text: string) =>
        kind === 'text' ? f.emit(text) : f.tool({ rawOutput: { text } });
      emit('before scope change');
      const source = f.store.searchSource(f.scope.sessionId),
        published = f.published();
      if (change === 'owner') f.store.workspace.userId = 'another-owner';
      if (change === 'project') f.store.workspace.projects = [];
      if (change === 'metadata')
        putMeta(f.store.meta, 'session-' + f.scope.sessionId, {
          project: { kind: 'local', localProjectId: 'another-project' },
        });
      if (change === 'active-turn') f.host.active.set(f.scope.sessionId, { ...f.run });
      if (change === 'active-turn') emit('late');
      else assert.throws(() => emit('late'));
      assert.deepEqual(f.store.searchSource(f.scope.sessionId), source);
      assert.equal(f.published(), published);
      const item = durable(f).state.history[0].items![0] as any;
      assert.equal(kind === 'text' ? item.text : item.rawOutput.text, 'before scope change');
    });

test('generic edits still atomically combine checkpoints with attachments, attention and notifications', (t) => {
  const f = fixture(t);
  f.emit('durable streaming prefix');
  const before = durable(f),
    source = f.store.searchSource(f.scope.sessionId);
  const bytes = Buffer.from('synthetic attachment');
  const reference = {
    contentVersion: 1 as const,
    attachmentId: 'attachment-a',
    name: 'fixture.txt',
    content: {
      version: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length,
      mediaType: 'text/plain',
    },
  };
  assert.throws(
    () =>
      f.host.edit(
        f.scope.sessionId,
        f.run,
        (turn) => {
          f.store.saveAttachment(f.scope, reference, bytes);
          f.store.referenceAttachment(f.scope, reference.attachmentId);
          turn.items.push({ type: 'attachment', attachment: reference });
          f.store.attention.recordOutcome({
            sessionId: f.scope.sessionId,
            assistantTurnId: f.run.turnId,
            userTurnId: f.run.userTurnId,
            localProjectId: f.scope.localProjectId,
            cause: 'agent_returned',
            summary: 'synthetic',
          });
          f.store.notifications.record({ ...f.scope, turnId: f.run.turnId }, 'completed');
        },
        false,
        () => {
          throw Error('synthetic combined write failure');
        },
      ),
    /synthetic combined write failure/,
  );
  assert.deepEqual(durable(f), before);
  assert.deepEqual(f.store.searchSource(f.scope.sessionId), source);
  assert.equal(count(f, 'session_delta'), 1);
  for (const table of ['attachment', 'attention_item', 'notification_event'])
    assert.equal(count(f, table), 0);
});

test('delta-only output invalidates search, obeys expanded read budgets and indexes only durable text', async (t) => {
  const f = fixture(t);
  const request = {
    searchVersion: 1 as const,
    workspaceId: f.scope.workspaceId,
    localProjectId: f.scope.localProjectId,
    sessionId: f.scope.sessionId,
    scope: 'session' as const,
    query: 'newneedle',
    limit: 30,
  };
  await searchHostSessions(f.host, request);
  const indexed = f.store.searchIndexVersion(f.scope)!;
  f.emit('newneedle ' + content(20000));
  assert(f.store.searchSource(f.scope.sessionId)!.revision > indexed.revision);
  const snapshotBytes = Number(
    f.store.journal.db.prepare('SELECT length(snapshot) AS bytes FROM session').get()!.bytes,
  );
  const limited = await searchHostSessions(f.host, request, undefined, {
    bytes: snapshotBytes + 100,
  });
  assert.equal(limited.partial, true);
  assert.equal(limited.hits.length, 0);
  const result = await searchHostSessions(f.host, request);
  assert.equal(result.hits.length, 1);
  assert.equal(
    f.store.searchIndexVersion(f.scope)!.revision,
    f.store.searchSource(f.scope.sessionId)!.revision,
  );
});

test('existing client permission and next-turn builders preserve text containers and original receipts', async (t) => {
  const f = fixture(t, { history: 'old scalar transcript' });
  f.emit('new streamed reply');
  const options = [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }];
  let resolutions = 0;
  f.run.permissions.set('request-a', {
    options,
    toolCall: {},
    resolve() {
      resolutions++;
    },
  });
  f.host.edit(f.scope.sessionId, f.run, (turn) => {
    turn.items.push({
      type: 'tool_call',
      toolCallId: 'tool-a',
      title: 'Synthetic edit',
      permissionRequest: { requestId: 'request-a', options },
    });
  });
  f.tool({ status: 'in_progress', rawOutput: { progress: 'while approval is pending' } });
  const response = await f.host.read(f.scope.sessionId, undefined, f.scope.localProjectId);
  const reviews = sessionPermissionReviews(readClientSession(response, f.scope), f.scope);
  assert.equal(reviews.length, 1);
  const permission = buildSessionPermission({
    scope: f.scope,
    read: response,
    review: reviews[0],
    outcome: { outcome: 'selected', optionId: 'allow' },
    operationId: 'permission-a',
  });
  const receipt = await f.host.mutate(permission, f.scope.localProjectId);
  assert.deepEqual(await f.host.mutate(permission, f.scope.localProjectId), receipt);
  assert.equal(resolutions, 1);
  f.host.finish(f.scope.sessionId, f.run, 'handled');
  const finished = await f.host.read(f.scope.sessionId, undefined, f.scope.localProjectId);
  const mutation = buildSessionTurn({
    scope: f.scope,
    read: finished,
    agent: finished.agent!,
    prompt: 'next input',
    operationId: 'next-operation',
    turnId: 'next-user',
    peerId: '42',
    now: '2026-01-01T00:01:00.000Z',
  });
  const validated = validateMutation(f.run.doc, f.store.meta, f.store.workspace, mutation);
  try {
    const state = read(validated.doc);
    assert.equal((state.history[0].items![0] as { text: string }).text, 'old scalar transcript');
    assert.equal((state.history[1].items![0] as { text: string }).text, 'new streamed reply');
    assert.equal((state.history[2].items![0] as { text: string }).text, 'next input');
  } finally {
    validated.doc.free();
  }
  assert.equal(f.opened(), 0);
});
