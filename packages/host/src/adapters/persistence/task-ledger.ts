import type { DatabaseSync } from 'node:sqlite';
import type { TaskLedger, TaskLedgerRow } from '../../features/collaboration/task-ledger';
/** Receives the same database as document persistence; it does not open another connection. */
export class SqliteTaskLedger implements TaskLedger {
  constructor(readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_execution(scope TEXT NOT NULL, id TEXT NOT NULL, sequence INTEGER NOT NULL, intent TEXT NOT NULL, state TEXT NOT NULL, claim TEXT, command TEXT, PRIMARY KEY(scope,id));
      CREATE INDEX IF NOT EXISTS collaboration_execution_order ON collaboration_execution(scope,sequence);
      CREATE INDEX IF NOT EXISTS collaboration_execution_phase ON collaboration_execution(scope,json_extract(state,'$.phase'),sequence);
      CREATE TABLE IF NOT EXISTS collaboration_reconciled(scope TEXT PRIMARY KEY, through INTEGER NOT NULL);
    `);
    if (database.prepare("SELECT 1 FROM sqlite_master WHERE name='collaboration_task'").get())
      database.exec(
        'INSERT OR IGNORE INTO collaboration_execution SELECT scope,id,sequence,intent,state,claim,command FROM collaboration_task',
      );
  }
  through(scope: string) {
    return Number(
      this.database.prepare('SELECT through FROM collaboration_reconciled WHERE scope=?').get(scope)
        ?.through ?? 0,
    );
  }
  reconciled(scope: string, through: number) {
    this.database
      .prepare(
        'INSERT INTO collaboration_reconciled VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET through=excluded.through',
      )
      .run(scope, through);
  }
  intent(scope: string, id: string) {
    const row = this.database
      .prepare('SELECT intent FROM collaboration_execution WHERE scope=? AND id=?')
      .get(scope, id);
    return row ? String(row.intent) : undefined;
  }
  insert(scope: string, id: string, sequence: number, intent: string, state: string) {
    this.database
      .prepare('INSERT INTO collaboration_execution VALUES(?,?,?,?,?,NULL,NULL)')
      .run(scope, id, sequence, intent, state);
  }
  row(scope: string, id: string) {
    return this.database
      .prepare(
        'SELECT intent,state,claim,command FROM collaboration_execution WHERE scope=? AND id=?',
      )
      .get(scope, id) as TaskLedgerRow | undefined;
  }
  updateState(scope: string, id: string, state: string) {
    this.database
      .prepare('UPDATE collaboration_execution SET state=? WHERE scope=? AND id=?')
      .run(state, scope, id);
  }
  active(scope: string) {
    return !!this.database
      .prepare(
        "SELECT 1 FROM collaboration_execution WHERE scope=? AND json_extract(state,'$.phase') IN ('claimed','dispatching','accepted','running') LIMIT 1",
      )
      .get(scope);
  }
  queued(scope: string) {
    const next = this.database.prepare(
      "SELECT intent,state FROM collaboration_execution WHERE scope=? AND json_extract(state,'$.phase')='queued' ORDER BY sequence LIMIT 1",
    );
    return () => next.get(scope) as { intent: string; state: string } | undefined;
  }
  updateClaim(scope: string, id: string, claim: string) {
    this.database
      .prepare('UPDATE collaboration_execution SET claim=? WHERE scope=? AND id=?')
      .run(claim, scope, id);
  }
  updateCommand(scope: string, id: string, command: string) {
    this.database
      .prepare('UPDATE collaboration_execution SET command=? WHERE scope=? AND id=?')
      .run(command, scope, id);
  }
  activeRows(scope: string) {
    return this.database
      .prepare(
        "SELECT id,state FROM collaboration_execution WHERE scope=? AND json_extract(state,'$.phase') IN ('claimed','dispatching','accepted','running')",
      )
      .all(scope)
      .map((row) => ({ id: String(row.id), state: String(row.state) }));
  }
}
