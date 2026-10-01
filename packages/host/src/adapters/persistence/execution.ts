import { sessionExecutionSchema, type SessionExecution } from '@moor/protocol/git-protocol';
import { assert } from '@moor/protocol/protocol';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import type { AttachmentScope } from '../../features/attachments/model';
import type { ExecutionRecord } from '../../features/git/execution-model';
import type { ExecutionPersistence } from '../../features/persistence/execution';
import { validateManagedWorktreeRoot } from '../git/worktree';

export type ExecutionLease = AttachmentScope & {
  rootPath: string;
  projectRoot: string;
  executionId: string;
  executionRevision: number;
};
const values = (scope: AttachmentScope) => [
  scope.workspaceId,
  scope.userId,
  scope.machineId,
  scope.localProjectId,
  scope.sessionId,
];
const shared = (): SessionExecution => ({ mode: 'shared', status: 'ready', revision: 0 });
export class SessionExecutionStore implements ExecutionPersistence {
  constructor(
    private db: DatabaseSync,
    private worktreeRoot?: string,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS session_execution(
      workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,machine_id TEXT NOT NULL,
      project_id TEXT NOT NULL,session_id TEXT PRIMARY KEY,record TEXT NOT NULL
    )`);
    // Process restart never reruns a staged Git command or invents its outcome.
    db.exec(`UPDATE session_execution SET record=json_set(record,'$.execution.status','unknown','$.execution.reason','Git 操作期间执行服务已重启，请手动查询原操作。')
      WHERE json_extract(record,'$.execution.status') IN ('creating','removing')`);
  }
  scopeMatches(scope: AttachmentScope) {
    const row = this.db
      .prepare('SELECT * FROM session_execution WHERE session_id=?')
      .get(scope.sessionId);
    return (
      !row ||
      (row.workspace_id === scope.workspaceId &&
        row.user_id === scope.userId &&
        row.machine_id === scope.machineId &&
        row.project_id === scope.localProjectId)
    );
  }
  get(scope: AttachmentScope): ExecutionRecord | undefined {
    assert(this.scopeMatches(scope), 404, '会话执行目录不属于此项目副本');
    const row = this.db
      .prepare('SELECT record FROM session_execution WHERE session_id=?')
      .get(scope.sessionId);
    if (!row) return;
    const record = JSON.parse(String(row.record)) as ExecutionRecord;
    assert(
      isDeepStrictEqual(
        record.scope,
        Object.fromEntries(
          Object.entries(scope).filter(([key]) =>
            ['workspaceId', 'userId', 'machineId', 'localProjectId', 'sessionId'].includes(key),
          ),
        ),
      ),
      409,
      '会话执行目录范围已变化',
    );
    sessionExecutionSchema.parse(record.execution);
    return record;
  }
  put(record: ExecutionRecord) {
    assert(this.scopeMatches(record.scope), 404, '会话执行目录不属于此项目副本');
    sessionExecutionSchema.parse(record.execution);
    this.db
      .prepare(
        'INSERT INTO session_execution VALUES(?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET record=excluded.record',
      )
      .run(...values(record.scope), JSON.stringify(record));
  }
  removeRejected(scope: AttachmentScope, operationId: string) {
    assert(this.scopeMatches(scope), 404, '会话执行目录不属于此项目副本');
    const result = this.db
      .prepare(
        "DELETE FROM session_execution WHERE session_id=? AND json_extract(record,'$.operationId')=?",
      )
      .run(scope.sessionId, operationId);
    assert(result.changes === 1, 409, '会话 Git 操作已变化');
  }
  info(scope: AttachmentScope) {
    return this.get(scope)?.execution ?? shared();
  }
  boundSessions(scope: AttachmentScope, executionId?: string) {
    if (!executionId || executionId === 'shared') return 1;
    return Number(
      this.db
        .prepare(
          `SELECT count(*) AS n FROM session_execution WHERE workspace_id=? AND user_id=? AND machine_id=? AND project_id=? AND json_extract(record,'$.execution.executionId')=? AND json_extract(record,'$.execution.status')!='removed'`,
        )
        .get(...values(scope).slice(0, 4), executionId)!.n,
    );
  }
  target(executionId: string) {
    assert(this.worktreeRoot, 409, '当前主机未配置可持久化的会话工作目录');
    mkdirSync(this.worktreeRoot, { recursive: true, mode: 0o700 });
    assert(
      lstatSync(this.worktreeRoot).isDirectory() && !lstatSync(this.worktreeRoot).isSymbolicLink(),
      409,
      '主机工作目录不可用',
    );
    return join(realpathSync(this.worktreeRoot), executionId);
  }
  lease(scope: AttachmentScope & { rootPath: string }): ExecutionLease {
    const record = this.get(scope),
      execution = record?.execution ?? shared();
    assert(
      execution.status === 'ready',
      409,
      execution.status === 'removed'
        ? '此会话工作目录已清理，请新建会话后发送指令'
        : '此会话的 Git 操作尚未确认，请先查询原操作',
    );
    if (record) {
      assert(
        record.repository.projectRoot === realpathSync(scope.rootPath),
        409,
        '原项目目录已变化',
      );
      assert(record.managed, 409, '会话工作目录尚未确认');
      validateManagedWorktreeRoot(record.repository, record.managed);
    }
    return {
      ...scope,
      projectRoot: scope.rootPath,
      rootPath: record?.managed?.cwd ?? scope.rootPath,
      executionId: execution.executionId ?? 'shared',
      executionRevision: execution.revision,
    };
  }
}
