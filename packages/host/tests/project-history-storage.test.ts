import test from 'node:test';
import strict from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ProjectHistoryStore, type ProjectHistoryScope } from '../src/projects/history';
import type { ProjectSnapshot } from '../src/projects/snapshot';

const scope: ProjectHistoryScope = {
  workspaceId: 'host-a',
  userId: 'user-a',
  machineId: 'machine-a',
  localProjectId: 'project-a',
  sessionId: 'session-a',
};
const digest = (text: string) => 'sha256:' + createHash('sha256').update(text).digest('hex');
function snapshot(files: Record<string, string>): ProjectSnapshot {
  return {
    version: 1,
    source: 'git',
    partial: false,
    enumerationComplete: true,
    issues: [],
    bytesRead: Object.values(files).reduce((sum, text) => sum + Buffer.byteLength(text), 0),
    files: Object.entries(files).map(([path, text]) => ({
      path,
      size: Buffer.byteLength(text),
      state: 'text',
      metadataVersion: digest(text),
      version: digest(text),
      mediaType: 'text/plain',
      text,
    })),
  };
}
function freeze(
  store: ProjectHistoryStore,
  turnId: string,
  before: ProjectSnapshot,
  after: ProjectSnapshot,
) {
  store.begin(scope, turnId);
  store.saveBefore(scope, turnId, before);
  return store.finish(scope, turnId, before, after);
}
function legacy(db: DatabaseSync, turnId = 'turn-legacy') {
  db.exec(`CREATE TABLE IF NOT EXISTS project_diff(
    workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,machine_id TEXT NOT NULL,
    project_id TEXT NOT NULL,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,
    reference TEXT NOT NULL,before_snapshot TEXT,after_snapshot TEXT,summary TEXT,
    PRIMARY KEY(workspace_id,user_id,machine_id,project_id,session_id,turn_id)
  )`);
  const before = snapshot({ 'file.txt': 'original frozen bytes\n' }),
    after = snapshot({ 'file.txt': 'changed frozen bytes\n' });
  const reference = {
    contentVersion: 1,
    basis: 'project-snapshot',
    turnId,
    diffId: 'legacy-' + turnId,
    state: 'ready',
    changeCount: 1,
    version: digest('original public reference'),
  };
  const summary = {
    reference,
    partial: false,
    issues: [],
    changes: [
      {
        path: 'file.txt',
        kind: 'modified',
        before: {
          path: 'file.txt',
          size: before.files[0].size,
          state: 'text',
          version: before.files[0].version,
          mediaType: 'text/plain',
        },
        after: {
          path: 'file.txt',
          size: after.files[0].size,
          state: 'text',
          version: after.files[0].version,
          mediaType: 'text/plain',
        },
      },
    ],
  };
  db.prepare('INSERT INTO project_diff VALUES(?,?,?,?,?,?,?,?,?,?)').run(
    scope.workspaceId,
    scope.userId,
    scope.machineId,
    scope.localProjectId,
    scope.sessionId,
    turnId,
    JSON.stringify(reference),
    JSON.stringify(before),
    JSON.stringify(after),
    JSON.stringify(summary),
  );
  return { reference, summary, before, after };
}

test('unchanged turns share immutable file bytes while retaining complete independent manifests', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = new ProjectHistoryStore(db),
    content = 'synthetic unchanged file\n'.repeat(2000),
    input = snapshot({ 'file.txt': content });
  for (let i = 0; i < 100; i++) freeze(store, 'turn-' + i, input, input);
  strict.equal(db.prepare('SELECT COUNT(*) AS count FROM project_snapshot_blob').get()!.count, 1);
  strict.equal(
    db.prepare('SELECT SUM(length(CAST(text AS BLOB))) AS bytes FROM project_snapshot_blob').get()!
      .bytes,
    Buffer.byteLength(content),
  );
  strict.equal(
    db.prepare('SELECT COUNT(*) AS count FROM project_snapshot_reference').get()!.count,
    200,
  );
  const rows = db
    .prepare('SELECT before_snapshot,after_snapshot,snapshot_format FROM project_diff')
    .all();
  strict.equal(rows.length, 100);
  for (const row of rows) {
    strict.equal(row.snapshot_format, 2);
    const before = JSON.parse(String(row.before_snapshot));
    strict.equal(before.storageVersion, 2);
    strict.equal(before.snapshot.files.length, 1);
    strict.equal(before.snapshot.files[0].text, undefined);
    strict.equal(before.snapshot.files[0].textBlob, digest(content));
    strict.equal(row.after_snapshot, row.before_snapshot);
  }
});

test('inline legacy snapshots migrate once without changing public references, summaries or frozen bytes', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const old = legacy(db),
    store = new ProjectHistoryStore(db),
    result = store.readFile(scope, old.reference.turnId, 'file.txt', old.reference.version);
  strict.deepEqual(result.reference, old.reference);
  strict.equal(result.before?.text, old.before.files[0].text);
  strict.equal(result.after?.text, old.after.files[0].text);
  strict.deepEqual(store.read(scope, old.reference.turnId), old.summary);
  const migrated = db.prepare('SELECT * FROM project_diff').get();
  strict.equal(migrated!.snapshot_format, 2);
  strict.equal(migrated!.reference, JSON.stringify(old.reference));
  strict.equal(migrated!.summary, JSON.stringify(old.summary));
  db.exec(
    "CREATE TRIGGER reject_repeat_migration BEFORE UPDATE ON project_diff BEGIN SELECT RAISE(ABORT,'must not remigrate'); END",
  );
  strict.doesNotThrow(() => new ProjectHistoryStore(db));
  strict.deepEqual(db.prepare('SELECT * FROM project_diff').get(), migrated);
});

test('migration failure rolls back earlier converted rows and content, then can resume from intact legacy data', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const first = legacy(db, 'turn-1');
  legacy(db, 'turn-2');
  db.prepare('UPDATE project_diff SET after_snapshot=? WHERE turn_id=?').run('{invalid', 'turn-2');
  strict.throws(() => new ProjectHistoryStore(db), SyntaxError);
  strict.equal(
    db.prepare('SELECT snapshot_format FROM project_diff WHERE turn_id=?').get('turn-1')!
      .snapshot_format,
    1,
  );
  strict.equal(
    db.prepare('SELECT before_snapshot FROM project_diff WHERE turn_id=?').get('turn-1')!
      .before_snapshot,
    JSON.stringify(first.before),
  );
  strict.equal(db.prepare('SELECT COUNT(*) AS count FROM project_snapshot_blob').get()!.count, 0);
  strict.equal(
    db.prepare('SELECT COUNT(*) AS count FROM project_snapshot_reference').get()!.count,
    0,
  );
  db.prepare('UPDATE project_diff SET after_snapshot=? WHERE turn_id=?').run(
    JSON.stringify(first.after),
    'turn-2',
  );
  const store = new ProjectHistoryStore(db);
  strict.equal(
    store.readFile(scope, 'turn-1', 'file.txt').before?.text,
    first.before.files[0].text,
  );
  strict.equal(db.prepare('SELECT COUNT(*) AS count FROM project_snapshot_blob').get()!.count, 2);
});

test('failed finalization rolls back new blobs and manifests and composes with the outer host transaction', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = new ProjectHistoryStore(db),
    before = snapshot({ 'file.txt': 'before' }),
    after = snapshot({ 'file.txt': 'after' });
  store.begin(scope, 'turn-a');
  store.saveBefore(scope, 'turn-a', before);
  db.exec(
    "CREATE TRIGGER fail_finalization BEFORE UPDATE ON project_diff BEGIN SELECT RAISE(ABORT,'synthetic finalization failure'); END",
  );
  strict.throws(
    () => store.finish(scope, 'turn-a', before, after),
    /synthetic finalization failure/,
  );
  strict.equal(db.prepare('SELECT COUNT(*) AS count FROM project_snapshot_blob').get()!.count, 1);
  strict.equal(
    db.prepare('SELECT COUNT(*) AS count FROM project_snapshot_reference').get()!.count,
    1,
  );
  strict.equal(store.read(scope, 'turn-a')!.reference.state, 'pending');
  strict.equal(store.row(scope, 'turn-a')!.after_snapshot, null);
  db.exec('DROP TRIGGER fail_finalization');
  db.exec('BEGIN IMMEDIATE');
  store.finish(scope, 'turn-a', before, after);
  db.exec('ROLLBACK');
  strict.equal(store.read(scope, 'turn-a')!.reference.state, 'pending');
  strict.equal(db.prepare('SELECT COUNT(*) AS count FROM project_snapshot_blob').get()!.count, 1);
  const reference = store.finish(scope, 'turn-a', before, after);
  strict.equal(store.readFile(scope, 'turn-a', 'file.txt', reference.version).after?.text, 'after');
});

test('references prevent deleting or replacing frozen content and reads detect missing or altered blobs', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = new ProjectHistoryStore(db);
  freeze(store, 'turn-a', snapshot({ 'file.txt': 'before' }), snapshot({ 'file.txt': 'after' }));
  strict.throws(
    () => db.prepare('DELETE FROM project_snapshot_blob WHERE id=?').run(digest('before')),
    /still referenced/,
  );
  strict.throws(
    () =>
      db
        .prepare('UPDATE project_snapshot_blob SET text=? WHERE id=?')
        .run('tampered', digest('before')),
    /immutable/,
  );
  strict.throws(
    () =>
      db
        .prepare('INSERT OR REPLACE INTO project_snapshot_blob VALUES(?,?)')
        .run(digest('before'), 'replacement'),
    /immutable/,
  );
  strict.throws(
    () =>
      db
        .prepare('INSERT INTO project_snapshot_reference VALUES(?,?,?,?)')
        .run('synthetic', 'before', 'missing.txt', digest('absent')),
    /missing/,
  );
  db.exec('DROP TRIGGER project_snapshot_blob_immutable');
  db.prepare('UPDATE project_snapshot_blob SET text=? WHERE id=?').run(
    'tampered',
    digest('before'),
  );
  strict.throws(() => store.readFile(scope, 'turn-a', 'file.txt'), /缺失或与摘要不匹配/);
  db.exec('DROP TRIGGER project_snapshot_blob_referenced');
  db.prepare('DELETE FROM project_snapshot_blob WHERE id=?').run(digest('before'));
  strict.throws(() => store.readFile(scope, 'turn-a', 'file.txt'), /缺失或与摘要不匹配/);
});

test('removing a historical record releases only its own references and leaves shared blobs protected', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = new ProjectHistoryStore(db),
    content = snapshot({ 'file.txt': 'shared bytes' });
  freeze(store, 'turn-a', content, content);
  freeze(store, 'turn-b', content, content);
  db.prepare('DELETE FROM project_diff WHERE turn_id=?').run('turn-a');
  strict.equal(
    db.prepare('SELECT COUNT(*) AS count FROM project_snapshot_reference').get()!.count,
    2,
  );
  strict.throws(
    () => db.prepare('DELETE FROM project_snapshot_blob WHERE id=?').run(digest('shared bytes')),
    /still referenced/,
  );
  db.prepare('DELETE FROM project_diff WHERE turn_id=?').run('turn-b');
  strict.equal(
    db.prepare('SELECT COUNT(*) AS count FROM project_snapshot_reference').get()!.count,
    0,
  );
  strict.doesNotThrow(() =>
    db.prepare('DELETE FROM project_snapshot_blob WHERE id=?').run(digest('shared bytes')),
  );
});

test('content deduplication does not bypass expanded search budgets or change old diff results', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = new ProjectHistoryStore(db),
    original = 'unchanged private fixture\n'.repeat(2000),
    before = snapshot({ 'file.txt': 'before', 'large.txt': original }),
    after = snapshot({ 'file.txt': 'after', 'large.txt': original }),
    reference = freeze(store, 'turn-a', before, after);
  const small = store.searchDiffs(scope, [{ reference, itemIndex: 0 }], 12000);
  strict.equal(small.budgetExceeded, true);
  strict.deepEqual(small.diffs, []);
  const large = store.searchDiffs(scope, [{ reference, itemIndex: 0 }], 1024 * 1024);
  strict.equal(large.budgetExceeded, false);
  strict.equal(large.diffs[0].diff.changes[0].before?.text, 'before');
  strict.equal(large.diffs[0].diff.changes[0].after?.text, 'after');
  before.files[0].text = 'caller later changed its object';
  after.files[0].text = 'caller later changed another object';
  const read = store.readFile(scope, 'turn-a', 'file.txt', reference.version);
  strict.equal(read.before?.text, 'before');
  strict.equal(read.after?.text, 'after');
  strict.throws(() =>
    store.readFile({ ...scope, sessionId: 'another-session' }, 'turn-a', 'file.txt'),
  );
});
