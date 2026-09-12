import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeStore, type AttachmentScope } from '../src/runtime/store';
import { Flock, LoroDoc, metas, mirror, putMeta } from '../src/model';
import type { AgentConfig } from '../src/runtime/agent';
import { AppError } from '../src/protocol';

const identity = {
  id: 'workspace',
  name: 'Synthetic',
  userId: 'synthetic-user',
  machineId: 'machine',
  projects: [],
  agents: [],
};
const scope: AttachmentScope = {
  workspaceId: identity.id,
  userId: identity.userId,
  machineId: identity.machineId,
  localProjectId: 'project',
  sessionId: 'session',
};
const config = (): AgentConfig => ({
  id: 'legacy-agent',
  machineId: identity.machineId,
  name: 'Synthetic Agent',
  cliType: 'custom',
  agentType: 'synthetic',
  customAcp: { command: '/synthetic/acp-v1', args: ['--synthetic'] },
});
const conflict = (error: unknown) => error instanceof AppError && error.status === 409;

function directory(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-agent-registration-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function runtime(t: TestContext) {
  const root = directory(t),
    file = join(root, 'runtime.sqlite'),
    store = new RuntimeStore(file);
  Object.assign(store.workspace, identity);
  store.save('identity', Buffer.from(JSON.stringify(store.workspace)));
  t.after(() => store.close());
  return { store, file };
}
function legacy(t: TestContext, missingConfig = false) {
  const root = directory(t),
    file = join(root, 'runtime.sqlite'),
    project = join(root, 'project');
  mkdirSync(project);
  const db = new DatabaseSync(file);
  db.exec(
    'CREATE TABLE runtime_state(key TEXT PRIMARY KEY,value BLOB NOT NULL); CREATE TABLE session(id TEXT PRIMARY KEY,snapshot BLOB NOT NULL); CREATE TABLE agent_session(id TEXT PRIMARY KEY,native_id TEXT NOT NULL)',
  );
  const machine = new Flock(),
    meta = new Flock(),
    doc = new LoroDoc();
  machine.set(['localProject', 'project'], { id: 'project', name: 'Synthetic', rootPath: project });
  if (!missingConfig) machine.set(['agentConfig', 'legacy-agent'], config() as never);
  machine.commit();
  putMeta(meta, 'session-session', {
    id: 'session',
    userId: identity.userId,
    machineId: identity.machineId,
    project: { kind: 'local', localProjectId: 'project' },
    cliType: 'custom',
    agentType: 'synthetic',
    agentConfigId: 'legacy-agent',
    title: 'Legacy synthetic',
    createdAt: '2026-01-01T00:00:00Z',
    latestUserMsgId: 'user',
    lastHandledUserMsgId: 'user',
    lastMessageAt: 1,
    status: { type: 'idle' },
    isArchived: false,
  });
  const view = mirror(doc, 'session');
  view.setState((state) => {
    state.history.push({
      id: 'user',
      role: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      userId: identity.userId,
      userTurnId: undefined,
      finished: true,
      status: 'processing',
      read: true,
      inputConfig: undefined,
      fileDiff: null,
      items: [{ type: 'text', text: 'Synthetic legacy input' }],
    });
    state.history.push({
      id: 'assistant',
      role: 'assistant',
      userTurnId: 'user',
      userId: undefined,
      read: undefined,
      inputConfig: undefined,
      fileDiff: null,
      timestamp: '2026-01-01T00:00:01Z',
      finished: true,
      status: 'handled',
      items: [{ type: 'text', text: 'Synthetic legacy output' }],
    });
  });
  view.dispose();
  doc.commit();
  for (const [key, value] of [
    ['identity', Buffer.from(JSON.stringify(identity))],
    ['machine', machine.exportFile()],
    ['meta', meta.exportFile()],
  ] as const)
    db.prepare('INSERT INTO runtime_state VALUES(?,?)').run(key, value);
  const snapshot = doc.export({ mode: 'snapshot' });
  db.prepare('INSERT INTO session VALUES(?,?)').run('session', snapshot);
  db.prepare('INSERT INTO agent_session VALUES(?,?)').run('session', 'native-original');
  const originalMeta = metas(meta)['session-session'];
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE name IN ('session_agent_version','session_agent_binding')",
      )
      .get()!.n,
    0,
  );
  assert.deepEqual(
    db
      .prepare('PRAGMA table_info(agent_session)')
      .all()
      .map((row) => row.name),
    ['id', 'native_id'],
  );
  db.close();
  return { file, originalMeta, snapshot };
}

test('Runtime Agent registration is idempotent and edits produce a new ID without moving existing bindings or copying capabilities', (t) => {
  const { store } = runtime(t),
    original = store.registerAgent('my-preset', config());
  assert.equal(original.id, config().id);
  assert.deepEqual(store.registerAgent('my-preset', config()), original);
  assert.equal(
    store.journal.db.prepare('SELECT count(*) AS n FROM session_agent_version').get()!.n,
    1,
  );
  store.agents.bind(scope, original);
  store.machine.set(['capabilities', original.id], {
    models: [{ id: 'old-model', name: 'Old', efforts: [] }],
    modes: [],
  });
  store.machine.set(['inputCapabilities', original.id], {
    image: true,
    audio: false,
    embeddedContext: true,
  });
  store.saveMachine();
  const edited = { ...config(), customAcp: { command: '/synthetic/acp-v2', args: [] } },
    next = store.registerAgent('my-preset', edited);
  assert.notEqual(next.id, original.id);
  assert.equal(store.machine.get(['agentPreset', 'my-preset']), next.id);
  assert.equal(store.machine.get(['retiredAgent', original.id]), true);
  assert.equal(store.machine.get(['retiredAgent', next.id]), false);
  assert.deepEqual(store.agents.get(original.id), original);
  assert.deepEqual(store.agents.binding(scope), original);
  assert.deepEqual(store.machine.get(['agentConfig', original.id]), original);
  assert.equal(store.machine.get(['capabilities', next.id]), undefined);
  assert.equal(store.machine.get(['inputCapabilities', next.id]), undefined);
  assert.deepEqual(store.registerAgent('my-preset', edited), next);
  assert.equal(
    store.journal.db.prepare('SELECT count(*) AS n FROM session_agent_version').get()!.n,
    2,
  );
});

test('Runtime Agent registration rolls back both the private machine and version tables when machine persistence fails', (t) => {
  const { store } = runtime(t),
    original = store.registerAgent('my-preset', config()),
    previousMachine = store.machine;
  const persisted = Buffer.from(store.load('machine')!),
    rows = store.journal.db.prepare('SELECT * FROM session_agent_version ORDER BY id').all();
  store.journal.db.exec(
    "CREATE TRIGGER fail_agent_machine BEFORE INSERT ON runtime_state WHEN NEW.key='machine' BEGIN SELECT RAISE(ABORT,'synthetic machine write failure'); END",
  );
  assert.throws(
    () => store.registerAgent('my-preset', { ...config(), name: 'Edited preset' }),
    /synthetic machine write failure/,
  );
  assert.equal(store.machine, previousMachine);
  assert.equal(store.machine.get(['agentPreset', 'my-preset']), original.id);
  assert.equal(store.machine.get(['retiredAgent', original.id]), false);
  assert.deepEqual(Buffer.from(store.load('machine')!), persisted);
  assert.deepEqual(
    store.journal.db.prepare('SELECT * FROM session_agent_version ORDER BY id').all(),
    rows,
  );
  store.journal.db.exec('DROP TRIGGER fail_agent_machine');
  const next = store.registerAgent('my-preset', { ...config(), name: 'Edited preset' });
  assert.notEqual(next.id, original.id);
});

test('a shared Agent version remains selectable through another preset until its final preset advances', (t) => {
  const { store } = runtime(t);
  const original = store.registerAgent('preset-a', config());
  assert.deepEqual(store.registerAgent('preset-b', config()), original);
  store.agents.bind(scope, original);
  const updatedA = store.registerAgent('preset-a', { ...config(), name: 'Updated A' });
  assert.notEqual(updatedA.id, original.id);
  assert.equal(store.machine.get(['agentPreset', 'preset-a']), updatedA.id);
  assert.equal(store.machine.get(['agentPreset', 'preset-b']), original.id);
  assert.equal(store.machine.get(['retiredAgent', original.id]), false);
  assert.deepEqual(store.agents.get(original.id), original);
  const updatedB = store.registerAgent('preset-b', { ...config(), name: 'Updated B' });
  assert.notEqual(updatedB.id, original.id);
  assert.notEqual(updatedB.id, updatedA.id);
  assert.equal(store.machine.get(['agentPreset', 'preset-b']), updatedB.id);
  assert.equal(store.machine.get(['retiredAgent', original.id]), true);
  assert.equal(store.machine.get(['retiredAgent', updatedA.id]), false);
  assert.equal(store.machine.get(['retiredAgent', updatedB.id]), false);
  assert.deepEqual(store.agents.binding(scope), original);
});

test('direct edits to a remembered machine Agent ID cannot overwrite its snapshot or persisted machine state', (t) => {
  const { store } = runtime(t),
    original = store.registerAgent('my-preset', config()),
    persisted = Buffer.from(store.load('machine')!);
  store.agents.bind(scope, original);
  store.machine.set(['agentConfig', original.id], {
    ...original,
    customAcp: { command: '/synthetic/changed-directly', args: [] },
  } as never);
  assert.throws(() => store.saveMachine(), conflict);
  assert.deepEqual(store.agents.get(original.id), original);
  assert.deepEqual(store.agents.binding(scope), original);
  assert.deepEqual(Buffer.from(store.load('machine')!), persisted);
});

test('real legacy SQLite migration freezes original IDs, preserves metadata and history, and fills native Agent ownership durably', (t) => {
  const f = legacy(t);
  let store = new RuntimeStore(f.file);
  try {
    assert.deepEqual(store.agents.get('legacy-agent'), config());
    assert.deepEqual(store.agents.bySession('session'), { scope, config: config() });
    assert.deepEqual(metas(store.meta)['session-session'], f.originalMeta);
    assert.deepEqual(
      Buffer.from(
        store.journal.db.prepare('SELECT snapshot FROM session WHERE id=?').get('session')!
          .snapshot as Uint8Array,
      ),
      Buffer.from(f.snapshot),
    );
    assert.equal(
      store.nativeSession(
        'session',
        { executionId: 'shared', executionRevision: 0 },
        'legacy-agent',
      ),
      'native-original',
    );
    assert.equal(
      store.journal.db
        .prepare('SELECT agent_version_id FROM agent_session WHERE id=?')
        .get('session')!.agent_version_id,
      'legacy-agent',
    );
    assert.equal(Buffer.from(store.load('agent-bindings-v1')!).toString(), '1');
  } finally {
    store.close();
  }
  store = new RuntimeStore(f.file);
  try {
    assert.deepEqual(store.agents.bySession('session'), { scope, config: config() });
    assert.equal(store.nativeSession('session'), 'native-original');
    assert.deepEqual(metas(store.meta)['session-session'], f.originalMeta);
    assert.equal(
      store.journal.db.prepare('SELECT count(*) AS n FROM session_agent_version').get()!.n,
      1,
    );
  } finally {
    store.close();
  }
});

test('a legacy session missing its launch configuration is never guessed from a later registration or restart', (t) => {
  const f = legacy(t, true);
  let store = new RuntimeStore(f.file);
  try {
    assert.equal(store.agents.binding(scope), undefined);
    assert.equal(
      store.journal.db
        .prepare('SELECT agent_version_id FROM agent_session WHERE id=?')
        .get('session')!.agent_version_id,
      null,
    );
    store.registerAgent('my-preset', config());
    assert.equal(store.agents.binding(scope), undefined);
    assert.throws(
      () =>
        store.nativeSession(
          'session',
          { executionId: 'shared', executionRevision: 0 },
          'legacy-agent',
        ),
      conflict,
    );
  } finally {
    store.close();
  }
  store = new RuntimeStore(f.file);
  try {
    assert.deepEqual(store.agents.get('legacy-agent'), config());
    assert.equal(store.agents.bySession('session'), undefined);
    assert.equal(
      store.journal.db
        .prepare('SELECT agent_version_id FROM agent_session WHERE id=?')
        .get('session')!.agent_version_id,
      null,
    );
    assert.deepEqual(metas(store.meta)['session-session'], f.originalMeta);
    assert.throws(
      () =>
        store.nativeSession(
          'session',
          { executionId: 'shared', executionRevision: 0 },
          'legacy-agent',
        ),
      conflict,
    );
  } finally {
    store.close();
  }
});

test('legacy migration cannot assign Agent ownership over a conflicting immutable attachment scope', (t) => {
  const f = legacy(t),
    database = new DatabaseSync(f.file);
  database.exec(
    'CREATE TABLE attachment_scope(workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,machine_id TEXT NOT NULL,project_id TEXT NOT NULL,session_id TEXT PRIMARY KEY)',
  );
  database
    .prepare('INSERT INTO attachment_scope VALUES(?,?,?,?,?)')
    .run(scope.workspaceId, scope.userId, scope.machineId, 'other-project', scope.sessionId);
  database.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    const store = new RuntimeStore(f.file);
    try {
      assert.deepEqual(store.agents.get('legacy-agent'), config());
      assert.equal(store.agents.bySession(scope.sessionId), undefined);
      assert.equal(
        store.journal.db
          .prepare('SELECT agent_version_id FROM agent_session WHERE id=?')
          .get(scope.sessionId)!.agent_version_id,
        null,
      );
      assert.equal(
        store.journal.db
          .prepare('SELECT project_id FROM attachment_scope WHERE session_id=?')
          .get(scope.sessionId)!.project_id,
        'other-project',
      );
      assert.deepEqual(metas(store.meta)['session-session'], f.originalMeta);
      assert.throws(
        () =>
          store.nativeSession(
            scope.sessionId,
            { executionId: 'shared', executionRevision: 0 },
            'legacy-agent',
          ),
        conflict,
      );
    } finally {
      store.close();
    }
  }
});

test('native context recovery enforces the fixed Agent ID as well as execution identity and cannot be reassigned by a new preset version', (t) => {
  const { store } = runtime(t),
    first = store.registerAgent('my-preset', config()),
    execution = { executionId: 'managed-worktree', executionRevision: 1 };
  store.agents.bind(scope, first);
  store.setNativeSession(scope.sessionId, 'native-first', execution, first.id);
  const second = store.registerAgent('my-preset', { ...config(), name: 'New version' });
  assert.equal(store.nativeSession(scope.sessionId, execution, first.id), 'native-first');
  assert.throws(() => store.nativeSession(scope.sessionId, execution, second.id), conflict);
  assert.throws(
    () => store.setNativeSession(scope.sessionId, 'native-second', execution, second.id),
    conflict,
  );
  assert.throws(
    () => store.nativeSession(scope.sessionId, { ...execution, executionRevision: 2 }, first.id),
    conflict,
  );
  assert.throws(
    () => store.nativeSession(scope.sessionId, { ...execution, executionId: 'other' }, first.id),
    conflict,
  );
  assert.throws(
    () => store.setNativeSession('unbound-session', 'native-orphan', execution, first.id),
    conflict,
  );
  const row = store.journal.db
    .prepare('SELECT * FROM agent_session WHERE id=?')
    .get(scope.sessionId)!;
  assert.equal(row.native_id, 'native-first');
  assert.equal(row.agent_version_id, first.id);
  store.journal.db
    .prepare('UPDATE agent_session SET agent_version_id=? WHERE id=?')
    .run(second.id, scope.sessionId);
  assert.throws(() => store.nativeSession(scope.sessionId, execution), conflict);
});
