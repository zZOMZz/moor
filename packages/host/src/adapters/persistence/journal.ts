import type { AttachmentAction, AttachmentReceipt } from '@moor/protocol/attachment-protocol';
import { productCanonicalJson } from '@moor/protocol/canonical-json';
import type { ForkReceipt, SessionFork } from '@moor/protocol/fork-protocol';
import type { GitAction, GitActionReceipt } from '@moor/protocol/git-protocol';
import type { GithubAction, GithubReceipt } from '@moor/protocol/github-protocol';
import type {
  QuestionAnswer,
  QuestionReceipt,
  SteerReceipt,
  SteerRequest,
} from '@moor/protocol/interaction-protocol';
import { assert, type Mutation, type SessionAction } from '@moor/protocol/protocol';
import type { RespondPermission, SendTurn } from '@moor/protocol/session-intent-protocol';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { JournalOperation, OperationJournal } from '../../features/persistence/journal';
export class Journal implements OperationJournal {
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
  unfinishedGithubWrites() {
    return this.db
      .prepare(
        "SELECT id,approval,result FROM operation WHERE phase IN ('github-write-prepared','github-write-dispatched','github-write-unknown')",
      )
      .all() as { id: string; approval: string | null; result: string | null }[];
  }
  stageOriginal(
    scope: string,
    original: JournalOperation,
    phase: string,
    turnId: string | null,
    result: unknown,
    plan?: unknown,
  ) {
    this.db
      .prepare(
        'INSERT INTO operation(id,fingerprint,phase,turn_id,result,approval) VALUES(?,?,?,?,?,?)',
      )
      .run(
        original.operationId,
        this.fingerprint(scope, original),
        phase,
        turnId,
        result == null ? null : JSON.stringify(result),
        plan === undefined ? null : JSON.stringify(plan),
      );
  }
  settleOriginal(
    scope: string,
    original: JournalOperation,
    phase: string,
    result: unknown,
    expectedPhase?: string,
  ) {
    this.lookup(scope, original);
    if (result === undefined)
      this.db.prepare('UPDATE operation SET phase=? WHERE id=?').run(phase, original.operationId);
    else if (expectedPhase === undefined)
      this.db
        .prepare('UPDATE operation SET phase=?,result=? WHERE id=?')
        .run(phase, JSON.stringify(result), original.operationId);
    else
      this.db
        .prepare('UPDATE operation SET phase=?,result=? WHERE id=? AND phase=?')
        .run(phase, JSON.stringify(result), original.operationId, expectedPhase);
  }
  updatePlan(scope: string, original: JournalOperation, plan: unknown) {
    this.lookup(scope, original);
    this.db
      .prepare('UPDATE operation SET approval=? WHERE id=?')
      .run(JSON.stringify(plan), original.operationId);
  }
  has(id: string) {
    return Boolean(this.db.prepare('SELECT 1 FROM operation WHERE id=?').get(id));
  }
  fingerprint(workspace: string, m: JournalOperation, binding?: unknown) {
    // New business intents have stable semantic fingerprints independent of
    // parser/object key order. Legacy operations retain their original bytes.
    if ('intentVersion' in m)
      return createHash('sha256')
        .update(productCanonicalJson(['session-intent-v1', workspace, m, binding ?? null]))
        .digest('hex');
    return createHash('sha256')
      .update(JSON.stringify(binding === undefined ? [workspace, m] : [workspace, m, binding]))
      .digest('hex');
  }
  lookup(workspace: string, m: JournalOperation, binding?: unknown) {
    const r = this.db.prepare('SELECT * FROM operation WHERE id=?').get(m.operationId) as any;
    if (r)
      assert(
        r.fingerprint === this.fingerprint(workspace, m, binding),
        409,
        '重复编号对应不同请求',
      );
    return r;
  }
  stage(
    workspace: string,
    m: Mutation | SendTurn | RespondPermission,
    turnId: string,
    approval?: unknown,
    binding?: unknown,
  ) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO operation(id,fingerprint,phase,turn_id,result,approval) VALUES(?,?,?,?,NULL,?)',
      )
      .run(
        m.operationId,
        this.fingerprint(workspace, m, binding),
        'staged',
        turnId,
        approval ? JSON.stringify(approval) : null,
      );
  }
  accept(m: Mutation | SendTurn | RespondPermission) {
    const result = {
      accepted: true as const,
      delivered: true as const,
      operationId: m.operationId,
    };
    this.db
      .prepare('UPDATE operation SET phase=?,result=? WHERE id=?')
      .run('accepted', JSON.stringify(result), m.operationId);
    return result;
  }
  acceptGithub(scope: string, action: GithubAction, result: GithubReceipt) {
    this.db
      .prepare('INSERT INTO operation(id,fingerprint,phase,turn_id,result) VALUES(?,?,?,NULL,?)')
      .run(
        action.operationId,
        this.fingerprint(scope, action),
        'github-accepted',
        JSON.stringify(result),
      );
    return result;
  }
  abandonGithub(scope: string, action: GithubAction, result: GithubReceipt) {
    this.db
      .prepare('INSERT INTO operation(id,fingerprint,phase,turn_id,result) VALUES(?,?,?,NULL,?)')
      .run(
        action.operationId,
        this.fingerprint(scope, action),
        'github-abandoned',
        JSON.stringify(result),
      );
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
      .run('git-' + result.phase, JSON.stringify(result), action.operationId);
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
