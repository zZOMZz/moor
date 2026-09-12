import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { assert, type Mutation, type SessionAction } from '../protocol';
import type { AttachmentAction, AttachmentReceipt } from '../attachment-protocol';
import type { GitAction, GitActionReceipt } from '../git-protocol';
import type { SessionFork, ForkReceipt } from '../fork-protocol';
import type {
  QuestionAnswer,
  QuestionReceipt,
  SteerRequest,
  SteerReceipt,
} from '../interaction-protocol';
export type JournalOperation =
  | Mutation
  | SessionAction
  | AttachmentAction
  | QuestionAnswer
  | SteerRequest
  | GitAction
  | SessionFork;
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
  fingerprint(workspace: string, m: JournalOperation) {
    return createHash('sha256')
      .update(JSON.stringify([workspace, m]))
      .digest('hex');
  }
  lookup(workspace: string, m: JournalOperation) {
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
  acceptAttachmentAction(workspace: string, action: AttachmentAction, result: AttachmentReceipt) {
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
  acceptQuestion(workspace: string, answer: QuestionAnswer, result: QuestionReceipt) {
    this.db
      .prepare('INSERT INTO operation(id,fingerprint,phase,turn_id,result) VALUES(?,?,?,?,?)')
      .run(
        answer.operationId,
        this.fingerprint(workspace, answer),
        'accepted',
        answer.expectedTurnId,
        JSON.stringify(result),
      );
    return result;
  }
  stageSteer(workspace: string, request: SteerRequest) {
    assert(!this.lookup(workspace, request), 409, '追加指令编号已使用');
    this.db
      .prepare('INSERT INTO operation(id,fingerprint,phase,turn_id,result) VALUES(?,?,?,?,NULL)')
      .run(
        request.operationId,
        this.fingerprint(workspace, request),
        'steer-staged',
        request.expectedTurnId,
      );
  }
  settleSteer(
    workspace: string,
    request: SteerRequest,
    phase: 'accepted' | 'steer-unknown' | 'steer-rejected',
    result: SteerReceipt | { message: string },
  ) {
    const record = this.lookup(workspace, request);
    assert(record?.phase === 'steer-staged', 409, '追加指令状态已变化');
    this.db
      .prepare('UPDATE operation SET phase=?,result=? WHERE id=?')
      .run(phase, JSON.stringify(result), request.operationId);
    return result;
  }
  stageGit(scope: string, action: GitAction, plan: unknown) {
    assert(!this.lookup(scope, action), 409, 'Git 操作编号已使用');
    this.db
      .prepare(
        'INSERT INTO operation(id,fingerprint,phase,turn_id,result,approval) VALUES(?,?,?,NULL,NULL,?)',
      )
      .run(action.operationId, this.fingerprint(scope, action), 'git-staged', JSON.stringify(plan));
  }
  settleGit(scope: string, action: GitAction, result: GitActionReceipt) {
    const record = this.lookup(scope, action);
    assert(
      record && ['git-staged', 'git-unknown'].includes(record.phase),
      409,
      'Git 操作状态已变化',
    );
    this.db
      .prepare('UPDATE operation SET phase=?,result=? WHERE id=?')
      .run(
        result.phase === 'accepted'
          ? 'git-accepted'
          : result.phase === 'rejected'
            ? 'git-rejected'
            : 'git-unknown',
        JSON.stringify(result),
        action.operationId,
      );
    return result;
  }
  close() {
    this.db.close();
  }
  stageFork(scope: string, request: SessionFork) {
    assert(!this.lookup(scope, request), 409, 'Fork 操作编号已使用');
    this.db
      .prepare('INSERT INTO operation(id,fingerprint,phase,turn_id,result) VALUES(?,?,?,NULL,NULL)')
      .run(request.operationId, this.fingerprint(scope, request), 'fork-staged');
  }
  settleFork(scope: string, request: SessionFork, result: ForkReceipt) {
    const previous = this.lookup(scope, request);
    assert(
      previous && ['fork-staged', 'fork-unknown'].includes(previous.phase),
      409,
      'Fork 操作状态已变化',
    );
    this.db
      .prepare('UPDATE operation SET phase=?,result=? WHERE id=?')
      .run('fork-' + result.phase, JSON.stringify(result), request.operationId);
  }
}
