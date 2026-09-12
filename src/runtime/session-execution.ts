import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { AppError, assert } from '../protocol';
import { mirror, metas } from '../model';
import type { ContentScope } from '../content-protocol';
import type { AttachmentScope, RuntimeStore } from './store';
import {
  gitActionSchema,
  gitActionReceiptSchema,
  gitStateReadSchema,
  gitStateResultSchema,
  sessionExecutionSchema,
  type GitAction,
  type GitActionReceipt,
  type GitStateRead,
  type GitStateResult,
  type GitRepositoryState,
  type SessionExecution,
} from '../git-protocol';
import {
  readProjectGit,
  prepareProjectWorktree,
  inspectProjectWorktree,
  removeProjectWorktree,
  validateManagedWorktreeRoot,
  type GitRepository,
  type ManagedWorktree,
  type WorktreePlan,
} from './project-git';

export type ExecutionRecord = {
  scope: AttachmentScope;
  execution: SessionExecution;
  repository: GitRepository;
  plan: WorktreePlan;
  managed?: ManagedWorktree;
  operationId: string;
};
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
const safeMessage = 'Git 操作结果尚未确认；请手动查询原操作。不会自动重复创建或清理工作目录。';
export class SessionExecutionStore {
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
type RootLease = AttachmentScope & { rootPath: string };
type Host = {
  store: RuntimeStore;
  active: ReadonlyMap<string, unknown>;
  settlementFailures: ReadonlyMap<string, unknown>;
  ensureConnected(): void;
  projectRootLease(input: ContentScope, localProjectId?: string): RootLease;
  serial<T>(id: string, work: () => Promise<T>): Promise<T>;
};
const repositoryLocks = new Map<string, Promise<unknown>>();
async function repositorySerial<T>(id: string, work: () => Promise<T>): Promise<T> {
  const task = (repositoryLocks.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
  repositoryLocks.set(id, task);
  try {
    return await task;
  } finally {
    if (repositoryLocks.get(id) === task) repositoryLocks.delete(id);
  }
}
function unavailable(reason: string): GitRepositoryState {
  return {
    kind: 'unavailable',
    branches: [],
    changes: [],
    dirty: false,
    partial: true,
    outsideProjectChanges: false,
    version: 'sha256:' + createHash('sha256').update(reason).digest('hex'),
    issues: [reason],
    writeSupported: false,
  };
}
/** Native Git actions and prompt execution share one immutable session binding. */
export class SessionExecutionManager {
  readonly busy = new Set<string>();
  constructor(
    private host: Host,
    private git = {
      readProjectGit,
      prepareProjectWorktree,
      inspectProjectWorktree,
      removeProjectWorktree,
    },
  ) {}
  private current(lease: RootLease) {
    this.host.ensureConnected();
    assert(
      isDeepStrictEqual(this.host.projectRootLease(lease), lease),
      409,
      'Git 操作所属项目范围已变化',
    );
  }
  private scope(lease: RootLease): AttachmentScope {
    const { rootPath: _rootPath, ...scope } = lease;
    return scope;
  }
  private idle(id: string) {
    if (this.host.active.has(id) || this.host.settlementFailures.has(id)) return false;
    const meta = metas(this.host.store.meta)['session-' + id];
    if (
      meta &&
      ((meta.status as { type?: string } | undefined)?.type === 'working' ||
        (meta.latestUserMsgId && meta.latestUserMsgId !== meta.lastHandledUserMsgId))
    )
      return false;
    const view = mirror(this.host.store.doc(id), id);
    try {
      return !view
        .getState()
        .history.some(
          (turn) =>
            !turn.finished || (turn.role === 'user' && !turn.read && turn.status === 'pending'),
        );
    } finally {
      view.dispose();
    }
  }
  private fresh(scope: AttachmentScope) {
    return (
      !this.host.store.searchSource(scope.sessionId) &&
      !this.host.store.hasNativeSession(scope.sessionId) &&
      !metas(this.host.store.meta)['session-' + scope.sessionId]
    );
  }
  async read(input: GitStateRead, localProjectId?: string): Promise<GitStateResult> {
    const request = gitStateReadSchema.parse(input),
      lease = this.host.projectRootLease(request, localProjectId),
      scope = this.scope(lease);
    const record = this.host.store.executions.get(scope);
    let execution = record?.execution ?? shared(),
      repository: GitRepositoryState;
    if (record) {
      if (execution.status !== 'ready' || !record.managed)
        repository = unavailable(execution.reason ?? '此会话工作目录当前不可读取');
      else {
        const result = await this.git.inspectProjectWorktree(record.repository, record.managed);
        this.current(lease);
        if (result.status === 'ready') repository = result.state;
        else {
          repository = unavailable(result.reason);
          execution = { ...execution, status: 'unknown', reason: result.reason };
        }
      }
    } else {
      repository = (await this.git.readProjectGit(lease.rootPath)).state;
      this.current(lease);
    }
    const latest = this.host.store.executions.info(scope);
    assert(
      latest.revision === (record?.execution.revision ?? 0) &&
        latest.status === (record?.execution.status ?? 'ready'),
      409,
      '会话 Git 状态已变化，请刷新',
    );
    return gitStateResultSchema.parse({
      ...request,
      confirmed: true,
      repository,
      execution,
      canPrepare:
        !record &&
        !this.busy.has(scope.sessionId) &&
        this.fresh(scope) &&
        this.idle(scope.sessionId) &&
        repository.writeSupported,
      canRemove:
        !!record?.managed &&
        !this.busy.has(scope.sessionId) &&
        execution.status === 'ready' &&
        this.idle(scope.sessionId) &&
        repository.writeSupported &&
        !repository.dirty &&
        !repository.partial &&
        !repository.outsideProjectChanges,
    });
  }
  async action(input: GitAction, localProjectId?: string): Promise<GitActionReceipt> {
    const action = gitActionSchema.parse(input);
    assert(!this.busy.has(action.sessionId), 409, '此会话正在处理 Git 操作，请等待确认');
    this.busy.add(action.sessionId);
    try {
      return await this.host.serial(action.sessionId, async () => {
        const lease = this.host.projectRootLease(action, localProjectId),
          scope = this.scope(lease),
          store = this.host.store;
        const journalScope = JSON.stringify(values(scope)),
          previous = store.journal.lookup(journalScope, action);
        if (previous && ['git-accepted', 'git-rejected'].includes(previous.phase))
          return gitActionReceiptSchema.parse(JSON.parse(previous.result));
        if (previous) {
          assert(['git-staged', 'git-unknown'].includes(previous.phase), 409, 'Git 操作编号已使用');
          const record = store.executions.get(scope);
          assert(record?.operationId === action.operationId, 409, '此会话的 Git 操作已变化');
          return repositorySerial(record.repository.id, () =>
            this.recover(action, lease, record, journalScope),
          );
        }
        assert(this.idle(scope.sessionId), 409, '请先停止活动回合并保存结果，再处理工作目录');
        const record = store.executions.get(scope),
          info = record?.execution ?? shared();
        assert(info.revision === action.expectedRevision, 409, '会话执行目录版本已变化，请刷新');
        if (action.action === 'prepare') {
          assert(!record && this.fresh(scope), 409, '只能为尚未发送指令的新会话准备工作目录');
          const read = await this.git.readProjectGit(lease.rootPath);
          this.current(lease);
          assert(
            read.repository && read.state.writeSupported,
            409,
            '此项目当前不支持准备 Git 工作目录',
          );
          return repositorySerial(read.repository.id, async () => {
            this.current(lease);
            assert(this.idle(scope.sessionId) && this.fresh(scope), 409, '会话状态已变化');
            const executionId = 'execution_' + randomUUID();
            const plan: WorktreePlan = {
              targetPath: store.executions.target(executionId),
              baseBranch: action.baseBranch,
              expectedOid: action.expectedOid,
              newBranch: action.newBranch,
            };
            const staged: ExecutionRecord = {
              scope,
              repository: read.repository!,
              plan,
              operationId: action.operationId,
              execution: {
                mode: 'worktree',
                status: 'creating',
                revision: action.expectedRevision + 1,
                executionId,
                branch: action.newBranch,
                baseOid: action.expectedOid,
              },
            };
            this.stage(action, staged, journalScope);
            try {
              const managed = await this.git.prepareProjectWorktree(staged.repository, plan);
              this.current(lease);
              return this.accept(
                action,
                { ...staged, managed, execution: { ...staged.execution, status: 'ready' } },
                journalScope,
              );
            } catch (error) {
              if (error instanceof AppError && error.rejected)
                return this.reject(action, staged, journalScope, error.message);
              return this.unknown(action, staged, journalScope);
            }
          });
        }
        assert(
          record?.managed &&
            info.mode === 'worktree' &&
            info.status === 'ready' &&
            info.executionId === action.executionId,
          409,
          '只能清理此会话已确认的 Moor 工作目录',
        );
        return repositorySerial(record.repository.id, async () => {
          this.current(lease);
          assert(this.idle(scope.sessionId), 409, '活动会话不能清理工作目录');
          const inspected = await this.git.inspectProjectWorktree(
            record.repository,
            record.managed!,
          );
          this.current(lease);
          assert(
            inspected.status === 'ready' &&
              inspected.state.version === action.expectedStateVersion &&
              inspected.state.writeSupported &&
              !inspected.state.dirty &&
              !inspected.state.partial &&
              !inspected.state.outsideProjectChanges,
            409,
            '工作目录有变更或状态已变化，请检查后刷新',
          );
          const staged = {
            ...record,
            operationId: action.operationId,
            execution: {
              ...record.execution,
              status: 'removing' as const,
              revision: action.expectedRevision + 1,
            },
          };
          this.stage(action, staged, journalScope);
          try {
            await this.git.removeProjectWorktree(record.repository, record.managed!, {
              expectedStateVersion: action.expectedStateVersion,
            });
            this.current(lease);
            return this.accept(
              action,
              { ...staged, execution: { ...staged.execution, status: 'removed' } },
              journalScope,
            );
          } catch (error) {
            if (error instanceof AppError && error.rejected)
              return this.reject(action, staged, journalScope, error.message, record);
            return this.unknown(action, staged, journalScope);
          }
        });
      });
    } finally {
      this.busy.delete(action.sessionId);
    }
  }
  private stage(action: GitAction, record: ExecutionRecord, journalScope: string) {
    this.host.store.transaction(() => {
      this.host.store.reserveAttachmentScope(record.scope);
      this.host.store.journal.stageGit(journalScope, action, record);
      this.host.store.executions.put(record);
    });
  }
  private accept(action: GitAction, record: ExecutionRecord, journalScope: string) {
    const result = gitActionReceiptSchema.parse({
      gitVersion: 1,
      workspaceId: action.workspaceId,
      localProjectId: action.localProjectId,
      sessionId: action.sessionId,
      operationId: action.operationId,
      phase: 'accepted',
      confirmed: true,
      execution: record.execution,
    });
    this.host.store.transaction(() => {
      this.host.store.executions.put(record);
      this.host.store.journal.settleGit(journalScope, action, result);
    });
    return result;
  }
  private unknown(
    action: GitAction,
    record: ExecutionRecord,
    journalScope: string,
  ): GitActionReceipt {
    const execution = { ...record.execution, status: 'unknown' as const, reason: safeMessage };
    const result = gitActionReceiptSchema.parse({
      gitVersion: 1,
      workspaceId: action.workspaceId,
      localProjectId: action.localProjectId,
      sessionId: action.sessionId,
      operationId: action.operationId,
      phase: 'unknown',
      confirmed: false,
      execution,
      message: safeMessage,
    });
    // A second SQLite failure leaves the original durable staged plan intact;
    // both that state and a saved unknown state block prompt execution.
    try {
      this.host.store.transaction(() => {
        this.host.store.executions.put({ ...record, execution });
        this.host.store.journal.settleGit(journalScope, action, result);
      });
    } catch {
      /* Original staged operation remains authoritative. */
    }
    return result;
  }
  private reject(
    action: GitAction,
    staged: ExecutionRecord,
    journalScope: string,
    message: string,
    previous?: ExecutionRecord,
  ): GitActionReceipt {
    const result = gitActionReceiptSchema.parse({
      gitVersion: 1,
      workspaceId: action.workspaceId,
      localProjectId: action.localProjectId,
      sessionId: action.sessionId,
      operationId: action.operationId,
      phase: 'rejected',
      confirmed: false,
      execution: previous?.execution ?? shared(),
      message: message.slice(0, 500),
    });
    try {
      this.host.store.transaction(() => {
        if (previous) this.host.store.executions.put(previous);
        else this.host.store.executions.removeRejected(staged.scope, action.operationId);
        this.host.store.journal.settleGit(journalScope, action, result);
      });
      return result;
    } catch {
      return this.unknown(action, staged, journalScope);
    }
  }
  private async recover(
    action: GitAction,
    lease: RootLease,
    record: ExecutionRecord,
    journalScope: string,
  ) {
    try {
      this.current(lease);
      assert(this.idle(record.scope.sessionId), 409, '活动会话不能恢复 Git 操作');
      const result = await this.git.inspectProjectWorktree(
        record.repository,
        record.managed ?? record.plan,
      );
      this.current(lease);
      const { reason: _reason, ...execution } = record.execution;
      if (action.action === 'prepare' && result.status === 'ready')
        return this.accept(
          action,
          {
            ...record,
            managed: result.managed,
            execution: { ...execution, status: 'ready' },
          },
          journalScope,
        );
      if (action.action === 'remove' && result.status === 'missing')
        return this.accept(
          action,
          { ...record, execution: { ...execution, status: 'removed' } },
          journalScope,
        );
    } catch {
      /* Inspection never repeats a Git mutation. */
    }
    return this.unknown(action, record, journalScope);
  }
}
