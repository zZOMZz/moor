import test, { type TestContext } from 'node:test';
import strict from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LoroDoc, mirror, putMeta } from '@moor/session/model';
import { RuntimeStore } from '../src/persistence/store';

function database(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'moor-recovery-index-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'host.sqlite');
}

function seed(
  store: RuntimeStore,
  id: string,
  options: { active?: boolean; pending?: 'question' | 'steer'; identity?: string } = {},
) {
  store.machine.set(['localProject', 'project-a'], { id: 'project-a', rootPath: '/synthetic' });
  store.saveMachine();
  putMeta(store.meta, 'session-' + id, {
    id,
    userId: store.workspace.userId,
    machineId: store.workspace.machineId,
    project: { kind: 'local', localProjectId: 'project-a' },
    status: { type: options.active ? 'working' : 'idle' },
  });
  store.reserveAttachmentScope({
    workspaceId: store.workspace.id,
    userId: store.workspace.userId,
    machineId: store.workspace.machineId,
    localProjectId: 'project-a',
    sessionId: id,
  });
  const doc = new LoroDoc(),
    view = mirror(doc, id);
  try {
    view.setState((state) => {
      state.session.id = options.identity ?? id;
      state.history.push({
        id: 'assistant-' + id,
        userTurnId: 'user-' + id,
        role: 'assistant',
        timestamp: '2026-01-01T00:00:00.000Z',
        userId: undefined,
        read: undefined,
        inputConfig: undefined,
        finished: !options.active,
        status: options.active ? undefined : 'handled',
        items: options.pending ? [{ type: options.pending, status: 'pending' }] : [],
        fileDiff: null,
      });
    });
    store.persist(id, doc);
    return doc.export({ mode: 'snapshot' });
  } finally {
    view.dispose();
    doc.free();
  }
}

function state(store: RuntimeStore, id: string) {
  const doc = store.doc(id),
    view = mirror(doc, id);
  try {
    return structuredClone(view.getState());
  } finally {
    view.dispose();
    doc.free();
  }
}

test('startup imports only unsettled snapshots and expires pending interactions without execution', (t) => {
  const file = database(t),
    original = new RuntimeStore(file);
  for (let i = 0; i < 200; i++) seed(original, 'completed-' + i);
  seed(original, 'active', { active: true });
  seed(original, 'question', { pending: 'question' });
  seed(original, 'steer', { pending: 'steer' });
  original.close();

  const imported: string[] = [],
    read = RuntimeStore.prototype.doc;
  t.mock.method(RuntimeStore.prototype, 'doc', function (this: RuntimeStore, id: string) {
    imported.push(id);
    return read.call(this, id);
  });
  const recovered = new RuntimeStore(file);
  strict.deepEqual(imported, ['active', 'question', 'steer']);
  strict.equal(state(recovered, 'active').history[0].status, 'failed');
  strict.equal(
    (state(recovered, 'question').history[0].items?.[0] as { status: string }).status,
    'expired',
  );
  strict.equal(
    (state(recovered, 'steer').history[0].items?.[0] as { status: string }).status,
    'unknown',
  );
  strict.equal(
    recovered.journal.db.prepare('SELECT COUNT(*) AS count FROM session_recovery').get()!.count,
    0,
  );
  recovered.close();
  imported.length = 0;
  const clean = new RuntimeStore(file);
  strict.deepEqual(imported, []);
  clean.close();
});

test('legacy index migration repairs missing identities once and preserves existing wrong identities', (t) => {
  const file = database(t),
    original = new RuntimeStore(file);
  seed(original, 'legacy-missing', { identity: '' });
  seed(original, 'legacy-wrong', { identity: 'other-session' });
  original.journal.db.exec(`
    DROP TRIGGER session_recovery_insert;
    DROP TRIGGER session_recovery_update;
    DROP TRIGGER session_recovery_delete;
    DROP TABLE session_recovery;
    DELETE FROM runtime_state WHERE key='session-recovery-v1';
  `);
  original.close();
  const imported: string[] = [],
    read = RuntimeStore.prototype.doc;
  t.mock.method(RuntimeStore.prototype, 'doc', function (this: RuntimeStore, id: string) {
    imported.push(id);
    return read.call(this, id);
  });
  const recovered = new RuntimeStore(file);
  strict.deepEqual(imported, ['legacy-missing', 'legacy-wrong']);
  strict.equal(state(recovered, 'legacy-missing').session.id, 'legacy-missing');
  strict.equal(state(recovered, 'legacy-wrong').session.id, 'other-session');
  recovered.close();
  imported.length = 0;
  const clean = new RuntimeStore(file);
  strict.deepEqual(imported, []);
  clean.close();
});

test('snapshot triggers conservatively track writes that bypass the current persist implementation', (t) => {
  const file = database(t),
    original = new RuntimeStore(file);
  const active = seed(original, 'session-a', { active: true });
  seed(original, 'session-a');
  strict.equal(
    original.journal.db.prepare('SELECT COUNT(*) AS count FROM session_recovery').get()!.count,
    0,
  );
  original.journal.db.prepare('UPDATE session SET snapshot=? WHERE id=?').run(active, 'session-a');
  original.close();
  const recovered = new RuntimeStore(file);
  strict.equal(state(recovered, 'session-a').history[0].status, 'failed');
  recovered.close();
});

test('recovery failure rolls back its snapshot and index so a later startup can finish safely', (t) => {
  const file = database(t),
    original = new RuntimeStore(file);
  const active = seed(original, 'active', { active: true });
  original.journal.db.exec(`CREATE TRIGGER synthetic_recovery_failure BEFORE INSERT ON session
    WHEN NEW.id='active' BEGIN SELECT RAISE(ABORT,'synthetic recovery failure'); END`);
  original.close();
  strict.throws(() => new RuntimeStore(file), /synthetic recovery failure/);
  const inspect = new DatabaseSync(file);
  strict.deepEqual(
    inspect.prepare('SELECT snapshot FROM session WHERE id=?').get('active')!.snapshot,
    active,
  );
  strict.ok(inspect.prepare('SELECT 1 FROM session_recovery WHERE session_id=?').get('active'));
  inspect.exec('DROP TRIGGER synthetic_recovery_failure');
  inspect.close();
  const recovered = new RuntimeStore(file);
  strict.equal(state(recovered, 'active').history[0].status, 'failed');
  recovered.close();
});
