import { AppError, assert } from '@moor/protocol/protocol';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentConfig } from '../../features/agents/driver';
import {
  agentForkAnchorSchema,
  codexAgentForkAnchorSchema,
  type AgentForkAnchor,
  type AgentForkCapabilities,
} from '../../features/agents/fork-model';
import type { AttachmentScope } from '../../features/attachments/model';
import type { ForkRecord } from '../../features/fork/model';
import type { ExecutionLease } from '../../features/git/execution-model';
import type { ForkPersistence } from '../../features/persistence/fork';
const hash = (value: string) => 'sha256:' + createHash('sha256').update(value).digest('hex');
const scopeKey = (scope: AttachmentScope) =>
  JSON.stringify([
    scope.workspaceId,
    scope.userId,
    scope.machineId,
    scope.localProjectId,
    scope.sessionId,
  ]);
function directoryIdentity(path: string) {
  try {
    const resolved = realpathSync(path),
      info = lstatSync(resolved, { bigint: true });
    assert(info.isDirectory() && !info.isSymbolicLink(), 409, 'Fork 工作目录不可用');
    return { path: resolved, dev: String(info.dev), ino: String(info.ino) };
  } catch {
    throw new AppError(409, 'Fork 工作目录不可用');
  }
}

export class SessionForkStore implements ForkPersistence {
  constructor(private db: DatabaseSync) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS session_fork(operation_id TEXT PRIMARY KEY,child_id TEXT UNIQUE NOT NULL,scope TEXT NOT NULL,record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session_fork_capability(session_id TEXT PRIMARY KEY,scope TEXT NOT NULL,binding TEXT NOT NULL,capabilities TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session_fork_anchor(scope TEXT NOT NULL,turn_id TEXT NOT NULL,binding TEXT NOT NULL,anchor TEXT NOT NULL,PRIMARY KEY(scope,turn_id));
  `);
    if (
      db
        .prepare('PRAGMA table_info(session_fork)')
        .all()
        .some((row) => row.name === 'snapshot')
    )
      db.exec('ALTER TABLE session_fork DROP COLUMN snapshot');
  }
  record(operationId: string): ForkRecord | undefined {
    const row = this.db
      .prepare('SELECT record FROM session_fork WHERE operation_id=?')
      .get(operationId);
    return row ? JSON.parse(String(row.record)) : undefined;
  }
  child(sessionId: string): ForkRecord | undefined {
    const row = this.db.prepare('SELECT record FROM session_fork WHERE child_id=?').get(sessionId);
    return row ? JSON.parse(String(row.record)) : undefined;
  }
  blocked(sessionId: string) {
    const row = this.child(sessionId);
    return !!row && !['accepted', 'rejected', 'abandoned'].includes(row.phase);
  }
  allowsGit(sessionId: string, operationId: string) {
    const row = this.child(sessionId);
    return (
      !this.blocked(sessionId) || (row?.phase === 'preparing' && row.gitOperationId === operationId)
    );
  }
  stage(record: ForkRecord) {
    this.db
      .prepare('INSERT INTO session_fork VALUES(?,?,?,?)')
      .run(
        record.request.operationId,
        record.request.childSessionId,
        scopeKey(record.scope),
        JSON.stringify(record),
      );
  }
  save(record: ForkRecord) {
    const result = this.db
      .prepare('UPDATE session_fork SET record=? WHERE operation_id=? AND scope=?')
      .run(JSON.stringify(record), record.request.operationId, scopeKey(record.scope));
    assert(result.changes === 1, 409, 'Fork 预留范围已变化');
  }
  private binding(execution: ExecutionLease, nativeId: string, agent: AgentConfig) {
    return JSON.stringify([
      execution.executionId,
      execution.executionRevision,
      nativeId,
      hash(JSON.stringify(agent)),
    ]);
  }
  saveCapabilities(
    scope: AttachmentScope,
    execution: ExecutionLease,
    nativeId: string,
    capabilities: AgentForkCapabilities,
    agent: AgentConfig,
  ) {
    this.db
      .prepare('INSERT OR REPLACE INTO session_fork_capability VALUES(?,?,?,?)')
      .run(
        scope.sessionId,
        scopeKey(scope),
        this.binding(execution, nativeId, agent),
        JSON.stringify(capabilities),
      );
  }
  capabilities(
    scope: AttachmentScope,
    execution: ExecutionLease,
    nativeId: string,
    agent: AgentConfig,
  ): AgentForkCapabilities | undefined {
    const row = this.db
      .prepare(
        'SELECT capabilities FROM session_fork_capability WHERE session_id=? AND scope=? AND binding=?',
      )
      .get(scope.sessionId, scopeKey(scope), this.binding(execution, nativeId, agent));
    return row ? JSON.parse(String(row.capabilities)) : undefined;
  }
  saveAnchor(
    scope: AttachmentScope,
    execution: ExecutionLease,
    turnId: string,
    anchor: AgentForkAnchor,
    agent: AgentConfig,
  ) {
    // Legacy Claude anchors remain readable, but no current callback may create
    // or replace one after Claude execution support has been removed.
    const parsed = codexAgentForkAnchorSchema.parse(anchor);
    this.db
      .prepare('INSERT OR REPLACE INTO session_fork_anchor VALUES(?,?,?,?)')
      .run(
        scopeKey(scope),
        turnId,
        this.binding(execution, anchor.sourceNativeId, agent),
        JSON.stringify(parsed),
      );
  }
  anchor(
    scope: AttachmentScope,
    execution: ExecutionLease,
    nativeId: string,
    turnId: string,
    agent: AgentConfig,
  ): AgentForkAnchor | undefined {
    const row = this.db
      .prepare('SELECT anchor FROM session_fork_anchor WHERE scope=? AND turn_id=? AND binding=?')
      .get(scopeKey(scope), turnId, this.binding(execution, nativeId, agent));
    return row ? agentForkAnchorSchema.parse(JSON.parse(String(row.anchor))) : undefined;
  }
}
