import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionAgentStore } from '../src/runtime/session-agent';
import { AppError } from '../src/protocol';
import type { AgentConfig } from '../src/runtime/agent';
import type { AttachmentScope } from '../src/runtime/store';

const scope: AttachmentScope = {
  workspaceId: 'workspace',
  userId: 'synthetic-user',
  machineId: 'machine',
  localProjectId: 'project',
  sessionId: 'session',
};
const configuration = (): AgentConfig => ({
  id: 'agent-v1',
  name: 'Synthetic Agent',
  machineId: 'machine',
  cliType: 'custom',
  agentType: 'synthetic',
  customAcp: { command: '/synthetic/private/acp', args: ['--synthetic', 'private-argument'] },
  runtimeOverrides: { codexPath: '/synthetic/private/codex' },
});
function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  t.after(() => db.close());
  return { db, agents: new SessionAgentStore(db) };
}
const conflict = (error: unknown) =>
  error instanceof AppError &&
  error.status === 409 &&
  !error.message.includes('/synthetic/private') &&
  !error.message.includes('private-argument');

test('Agent versions preserve only launch fields and ignore refreshed catalogue capabilities', (t) => {
  const { db, agents } = fixture(t),
    config = configuration();
  const withCache = {
    ...config,
    runConfig: { models: [], modes: [] },
    inputCapabilities: { image: true, audio: false, embeddedContext: true },
    unrelated: 'not-a-launch-field',
  };
  assert.deepEqual(agents.remember(withCache), config);
  const refreshed = {
    ...withCache,
    inputCapabilities: { image: false, audio: false, embeddedContext: false },
  };
  assert.deepEqual(agents.remember(refreshed), config);
  assert.equal(
    String(db.prepare('SELECT config FROM session_agent_version').get()!.config).includes(
      'not-a-launch-field',
    ),
    false,
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM session_agent_version').get()!.n, 1);
  assert.equal(agents.get('missing'), undefined);
  assert.equal(agents.binding(scope), undefined);
  assert.equal(agents.bySession(scope.sessionId), undefined);
});

test('same Agent version ID rejects changes to command, args, overrides, names or machine with safe errors', (t) => {
  const { agents } = fixture(t),
    original = configuration();
  agents.remember(original);
  for (const changed of [
    { ...original, customAcp: { ...original.customAcp!, command: '/synthetic/private/new' } },
    {
      ...original,
      customAcp: { ...original.customAcp!, args: ['private-argument', '--synthetic'] },
    },
    { ...original, runtimeOverrides: { codexPath: '/synthetic/private/other' } },
    { ...original, runtimeOverrides: undefined },
    { ...original, name: 'Edited' },
    { ...original, cliType: 'builtin' },
    { ...original, agentType: 'other' },
    { ...original, machineId: 'other-machine' },
  ])
    assert.throws(() => agents.remember(changed), conflict);
  assert.deepEqual(agents.get(original.id), original);
  assert.deepEqual(agents.remember({ ...original, id: 'agent-v2' }), {
    ...original,
    id: 'agent-v2',
  });
});

test('input objects and every returned nested Agent snapshot are isolated from stored bindings', (t) => {
  const { agents } = fixture(t),
    config = configuration(),
    expected = configuration();
  const remembered = agents.remember(config);
  config.customAcp!.args.push('input mutation');
  remembered.runtimeOverrides!.codexPath = '/changed';
  const bound = agents.bind(scope, expected);
  bound.customAcp!.args.push('return mutation');
  const loaded = agents.get(expected.id)!;
  loaded.name = 'changed';
  const binding = agents.binding(scope)!;
  binding.customAcp!.command = '/changed';
  const stored = agents.bySession(scope.sessionId)!;
  stored.scope.userId = 'changed';
  stored.config.customAcp!.args.length = 0;
  assert.deepEqual(agents.get(expected.id), expected);
  assert.deepEqual(agents.bySession(scope.sessionId), { scope, config: expected });
  assert.doesNotThrow(() => agents.assertCurrent(scope, expected));
});

test('bindings enforce all five scope fields, reject Agent changes and allow independent sessions', (t) => {
  const { db, agents } = fixture(t),
    config = configuration();
  assert.deepEqual(agents.bind(scope, config), config);
  assert.deepEqual(agents.bind({ ...scope }, { ...config }), config);
  for (const field of ['workspaceId', 'userId', 'machineId', 'localProjectId'] as const) {
    const changed = { ...scope, [field]: 'different' };
    assert.throws(() => agents.binding(changed), conflict);
    assert.throws(() => agents.bind(changed, config), conflict);
    assert.throws(() => agents.assertCurrent(changed, config), conflict);
  }
  assert.equal(agents.binding({ ...scope, sessionId: 'other-session' }), undefined);
  assert.throws(
    () => agents.assertCurrent({ ...scope, sessionId: 'other-session' }, config),
    conflict,
  );
  assert.throws(() => agents.bind(scope, { ...config, id: 'new-version' }), conflict);
  assert.equal(agents.get('new-version'), undefined);
  assert.throws(
    () =>
      agents.bind(
        { ...scope, sessionId: 'another' },
        { ...config, id: 'wrong-machine', machineId: 'wrong' },
      ),
    conflict,
  );
  assert.equal(agents.get('wrong-machine'), undefined);
  agents.bind({ ...scope, sessionId: 'independent', localProjectId: 'other-project' }, config);
  assert.equal(db.prepare('SELECT count(*) AS n FROM session_agent_binding').get()!.n, 2);
});

test('Agent snapshots and full session bindings survive reopening the same private SQLite database', (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moor-session-agent-'))),
    file = join(directory, 'runtime.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let db = new DatabaseSync(file),
    agents = new SessionAgentStore(db);
  agents.bind(scope, configuration());
  db.close();
  db = new DatabaseSync(file);
  agents = new SessionAgentStore(db);
  try {
    assert.deepEqual(agents.bySession(scope.sessionId), { scope, config: configuration() });
    assert.throws(() => agents.bind(scope, { ...configuration(), id: 'replacement' }), conflict);
    assert.equal(agents.get('replacement'), undefined);
  } finally {
    db.close();
  }
});

test('binding writes compose atomically with caller receipt transactions and roll back on later failure', (t) => {
  const { db, agents } = fixture(t);
  db.exec('CREATE TABLE receipt(id TEXT PRIMARY KEY); BEGIN');
  agents.bind(scope, configuration());
  db.prepare('INSERT INTO receipt VALUES(?)').run('operation');
  assert.ok(agents.binding(scope));
  db.exec('ROLLBACK');
  assert.equal(agents.get('agent-v1'), undefined);
  assert.equal(agents.bySession(scope.sessionId), undefined);
  assert.equal(db.prepare('SELECT count(*) AS n FROM receipt').get()!.n, 0);
  db.exec('BEGIN');
  agents.bind(scope, configuration());
  db.prepare('INSERT INTO receipt VALUES(?)').run('operation');
  db.exec('COMMIT');
  assert.deepEqual(agents.binding(scope), configuration());
  assert.equal(db.prepare('SELECT count(*) AS n FROM receipt').get()!.n, 1);
});

test('failed binding insert rolls back its newly remembered version and leaves an outer transaction usable', (t) => {
  const { db, agents } = fixture(t);
  db.exec(
    "CREATE TRIGGER fail_binding BEFORE INSERT ON session_agent_binding BEGIN SELECT RAISE(ABORT,'synthetic binding failure'); END",
  );
  assert.throws(() => agents.bind(scope, configuration()), /synthetic binding failure/);
  assert.equal(agents.get('agent-v1'), undefined);
  assert.equal(agents.binding(scope), undefined);
  db.exec('CREATE TABLE outer_write(id INTEGER); BEGIN');
  db.exec('INSERT INTO outer_write VALUES(1)');
  assert.throws(() => agents.bind(scope, configuration()), /synthetic binding failure/);
  db.exec('INSERT INTO outer_write VALUES(2); COMMIT; DROP TRIGGER fail_binding');
  assert.equal(db.prepare('SELECT count(*) AS n FROM outer_write').get()!.n, 2);
  assert.equal(agents.get('agent-v1'), undefined);
  agents.bind(scope, configuration());
});

test('malformed or corrupted private bindings fail closed instead of falling back to a current Agent', (t) => {
  const { db, agents } = fixture(t);
  const builtin: AgentConfig = {
    id: 'builtin',
    name: 'Builtin',
    machineId: 'machine',
    cliType: 'builtin',
    agentType: 'codex',
    runtimeOverrides: {},
  };
  assert.deepEqual(agents.remember(builtin), {
    id: 'builtin',
    name: 'Builtin',
    machineId: 'machine',
    cliType: 'builtin',
    agentType: 'codex',
  });
  assert.throws(() => agents.bind({ ...scope, userId: '' }, configuration()), conflict);
  assert.throws(
    () =>
      agents.remember({
        ...configuration(),
        customAcp: { command: '/synthetic', args: [undefined as any] },
      }),
    conflict,
  );
  agents.bind(scope, configuration());
  db.prepare('UPDATE session_agent_binding SET scope=? WHERE session_id=?').run(
    '{',
    scope.sessionId,
  );
  assert.throws(() => agents.binding(scope), conflict);
  db.prepare('UPDATE session_agent_binding SET scope=? WHERE session_id=?').run(
    JSON.stringify(scope),
    scope.sessionId,
  );
  db.prepare('UPDATE session_agent_version SET config=? WHERE id=?').run('{', 'agent-v1');
  assert.throws(() => agents.get('agent-v1'), conflict);
  assert.throws(() => agents.binding(scope), conflict);
});
