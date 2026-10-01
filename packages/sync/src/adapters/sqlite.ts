import { DatabaseSync } from 'node:sqlite';
import { id } from '@moor/protocol/protocol';
import { CollaborationDocuments } from '../document/documents';
import type { CollaborationDocumentRow, CollaborationPersistence } from '../document/persistence';

/** The application supplies its existing Host connection to share the unit of work. */
export class SqliteCollaborationPersistence implements CollaborationPersistence {
  readonly database: DatabaseSync;
  readonly #ownsDatabase: boolean;
  static prepare(database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_workspace(id TEXT PRIMARY KEY, owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collaboration_member(workspace TEXT NOT NULL, actor TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(workspace,actor));
      CREATE TABLE IF NOT EXISTS collaboration_session(scope TEXT PRIMARY KEY, target TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collaboration_document(scope TEXT PRIMARY KEY, snapshot TEXT NOT NULL, peer TEXT NOT NULL, revision INTEGER NOT NULL, sequence INTEGER NOT NULL);
    `);
  }
  constructor(file: string | DatabaseSync, prepared = false) {
    this.#ownsDatabase = typeof file === 'string';
    this.database = typeof file === 'string' ? new DatabaseSync(file) : file;
    if (this.#ownsDatabase) this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    if (!prepared) SqliteCollaborationPersistence.prepare(this.database);
  }
  close() {
    if (this.#ownsDatabase) this.database.close();
  }
  atomic<T>(work: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
  role(workspace: string, actor: string) {
    return this.database
      .prepare('SELECT role FROM collaboration_member WHERE workspace=? AND actor=?')
      .get(workspace, actor)?.role;
  }
  workspaceOwner(workspace: string) {
    const owner = this.database
      .prepare('SELECT owner FROM collaboration_workspace WHERE id=?')
      .get(workspace)?.owner;
    return owner === undefined ? undefined : String(owner);
  }
  createWorkspace(workspace: string, owner: string) {
    this.database.prepare('INSERT INTO collaboration_workspace VALUES(?,?)').run(workspace, owner);
    this.database
      .prepare('INSERT INTO collaboration_member VALUES(?,?,?)')
      .run(workspace, owner, 'owner');
  }
  setMember(workspace: string, actor: string, role: string | null) {
    if (role === null)
      this.database
        .prepare('DELETE FROM collaboration_member WHERE workspace=? AND actor=?')
        .run(workspace, actor);
    else
      this.database
        .prepare(
          'INSERT INTO collaboration_member VALUES(?,?,?) ON CONFLICT(workspace,actor) DO UPDATE SET role=excluded.role',
        )
        .run(workspace, actor, role);
  }
  sessions() {
    return this.database
      .prepare('SELECT scope,target FROM collaboration_session')
      .all()
      .map((row) => ({ scope: String(row.scope), target: String(row.target) }));
  }
  sessionTarget(scope: string) {
    const row = this.database
      .prepare('SELECT target FROM collaboration_session WHERE scope=?')
      .get(scope);
    return row ? String(row.target) : undefined;
  }
  registerSession(scope: string, target: string) {
    this.database.prepare('INSERT INTO collaboration_session VALUES(?,?)').run(scope, target);
  }
  document(scope: string) {
    return this.database
      .prepare('SELECT snapshot,peer,revision,sequence FROM collaboration_document WHERE scope=?')
      .get(scope) as CollaborationDocumentRow | undefined;
  }
  insertDocument(scope: string, row: CollaborationDocumentRow) {
    this.database
      .prepare('INSERT INTO collaboration_document VALUES(?,?,?,?,?)')
      .run(scope, row.snapshot, row.peer, row.revision, row.sequence);
  }
  updateDocument(scope: string, snapshot: string, revision: number, sequence: number) {
    this.database
      .prepare('UPDATE collaboration_document SET snapshot=?,revision=?,sequence=? WHERE scope=?')
      .run(snapshot, revision, sequence, scope);
  }
  upgradeDocument(scope: string, snapshot: string, peer: string) {
    this.database
      .prepare(
        'UPDATE collaboration_document SET snapshot=?,peer=?,revision=revision+1 WHERE scope=?',
      )
      .run(snapshot, peer, scope);
  }
  legacyDocument(scope: string) {
    const exists = (name: string) =>
      !!this.database
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(name);
    const operations = exists('collaboration_operation')
      ? this.database
          .prepare('SELECT rowid,body FROM collaboration_operation WHERE scope=? ORDER BY rowid')
          .all(scope)
          .map((row) => {
            const id = (JSON.parse(String(row.body)) as { operationId?: unknown }).operationId;
            const old =
              exists('collaboration_event') && typeof id === 'string'
                ? this.database
                    .prepare(
                      "SELECT sequence FROM collaboration_event WHERE scope=? AND kind='operation' AND json_extract(body,'$.operationId')=? ORDER BY sequence LIMIT 1",
                    )
                    .get(scope, id)
                : undefined;
            return {
              body: String(row.body),
              sequence: old ? Number(old.sequence) : Number(row.rowid),
            };
          })
      : [];
    const executions = exists('collaboration_task')
      ? this.database
          .prepare('SELECT state FROM collaboration_task WHERE scope=?')
          .all(scope)
          .map((row) => String(row.state))
      : [];
    return { operations, executions };
  }
}
/** Node composition only: the policy receives the constrained repository port. */
export class SqliteCollaboration extends CollaborationDocuments {
  readonly database: DatabaseSync;
  constructor(
    file: string | DatabaseSync,
    authorityId: string,
    now: () => number,
    prepared = false,
  ) {
    id.parse(authorityId);
    const persistence = new SqliteCollaborationPersistence(file, prepared);
    super(persistence, authorityId, now);
    this.database = persistence.database;
  }
}
