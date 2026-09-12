import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { assert, type Mutation, type SessionAction } from '../protocol';
export class Journal {
  db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS operation(id TEXT PRIMARY KEY,fingerprint TEXT,phase TEXT,turn_id TEXT,result TEXT)',
    );
    if (
      !this.db
        .prepare('PRAGMA table_info(operation)')
        .all()
        .some((c) => c.name === 'approval')
    )
      this.db.exec('ALTER TABLE operation ADD COLUMN approval TEXT');
  }
  has(id: string) {
    return Boolean(this.db.prepare('SELECT 1 FROM operation WHERE id=?').get(id));
  }
  fingerprint(workspace: string, m: Mutation | SessionAction) {
    return createHash('sha256')
      .update(JSON.stringify([workspace, m]))
      .digest('hex');
  }
  lookup(workspace: string, m: Mutation | SessionAction) {
    const r = this.db.prepare('SELECT * FROM operation WHERE id=?').get(m.operationId) as any;
    if (r) assert(r.fingerprint === this.fingerprint(workspace, m), 409, '重复编号对应不同请求');
    return r;
  }
  stage(workspace: string, m: Mutation, turnId: string, approval?: unknown) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO operation(id,fingerprint,phase,turn_id,result,approval) VALUES(?,?,?,?,NULL,?)',
      )
      .run(
        m.operationId,
        this.fingerprint(workspace, m),
        'staged',
        turnId,
        approval ? JSON.stringify(approval) : null,
      );
  }
  accept(m: Mutation) {
    const result = { accepted: true, delivered: true, operationId: m.operationId };
    this.db
      .prepare('UPDATE operation SET phase=?,result=? WHERE id=?')
      .run('accepted', JSON.stringify(result), m.operationId);
    return result;
  }
  acceptSessionAction(workspace: string, action: SessionAction, meta: Record<string, unknown>) {
    const result = { accepted: true, delivered: true, operationId: action.operationId, meta };
    this.db
      .prepare('INSERT INTO operation(id,fingerprint,phase,turn_id,result) VALUES(?,?,?,NULL,?)')
      .run(
        action.operationId,
        this.fingerprint(workspace, action),
        'accepted',
        JSON.stringify(result),
      );
    return result;
  }
  close() {
    this.db.close();
  }
}
