import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { Flock, metas, mirror, putMeta, vv } from '../model';
import { AppError, assert } from '../protocol';
import {
  forkOptionsReadSchema,
  forkOptionsResultSchema,
  forkReceiptSchema,
  sessionForkSchema,
  forkOperationSchema,
  forkOperationResultSchema,
  type ForkOperation,
  type ForkOperationResult,
  FORK_LIMITS,
  type ForkOptionsRead,
  type ForkOptionsResult,
  type ForkReceipt,
  type SessionFork,
  type ForkOrigin,
} from '../fork-protocol';
import type { AgentConfig, AgentDriver } from './agent';
import {
  agentForkAnchorSchema,
  type AgentForkAnchor,
  type AgentForkCapabilities,
} from './agent-fork';
import type { AttachmentScope, RuntimeStore } from './store';
import type { ExecutionLease, SessionExecutionManager } from './session-execution';
import type { ContentScope } from '../content-protocol';
import type { GitPrepare } from '../git-protocol';

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
type ForkRecord = {
  scope: AttachmentScope;
  request: SessionFork;
  origin: ForkOrigin;
  sourceExecution: ExecutionLease;
  sourceNativeId: string;
  agent: AgentConfig;
  capabilities: AgentForkCapabilities;
  anchor?: AgentForkAnchor;
  phase: 'preparing' | 'dispatched' | 'returned' | 'accepted' | 'rejected' | 'abandoned';
  gitOperationId?: string;
  targetExecution?: ExecutionLease;
  targetDirectory?: ReturnType<typeof directoryIdentity>;
  nativeId?: string;
};
export class SessionForkStore {
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
    const parsed = agentForkAnchorSchema.parse(anchor);
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
type Host = {
  store: RuntimeStore;
  active: ReadonlyMap<string, unknown>;
  settlementFailures: ReadonlyMap<string, unknown>;
  executionManager: SessionExecutionManager;
  ensureConnected(): void;
  projectLease(
    input: ContentScope,
    localProjectId?: string,
  ): AttachmentScope & { rootPath: string };
  projectRootLease(
    input: ContentScope,
    localProjectId?: string,
  ): AttachmentScope & { rootPath: string };
  executionLease(input: ContentScope, localProjectId?: string, allowNew?: boolean): ExecutionLease;
  checkExecutionLease(execution: ExecutionLease): void;
  serial<T>(id: string, work: () => Promise<T>): Promise<T>;
};
const unavailable: AgentForkCapabilities = {
  sameDirectory: false,
  worktree: false,
  turnCutoff: false,
  sameDirectoryUnavailableReason: '此 Agent 尚未报告经过验证的原生 Fork 能力',
  worktreeUnavailableReason: '尚无经过验证的原生工作目录 Fork 能力',
  turnCutoffUnavailableReason: '尚无经过验证的原生回合锚点',
};
export class SessionForkManager {
  readonly busy = new Set<string>();
  constructor(
    private host: Host,
    private driver: AgentDriver,
  ) {}
  private childScope(record: ForkRecord): AttachmentScope {
    return { ...record.scope, sessionId: record.request.childSessionId };
  }
  private idle(id: string) {
    const meta = metas(this.host.store.meta)['session-' + id];
    if (
      this.host.active.has(id) ||
      this.host.settlementFailures.has(id) ||
      this.host.store.forks.blocked(id) ||
      (meta?.status as any)?.type === 'working' ||
      (meta?.latestUserMsgId && meta.latestUserMsgId !== meta.lastHandledUserMsgId)
    )
      return false;
    const view = mirror(this.host.store.doc(id), id);
    try {
      return !view
        .getState()
        .history.some(
          (t) => !t.finished || (t.role === 'user' && !t.read && t.status === 'pending'),
        );
    } finally {
      view.dispose();
    }
  }
  private source(input: ContentScope, localProjectId?: string) {
    const lease = this.host.projectLease(input, localProjectId),
      { rootPath: _root, ...scope } = lease,
      execution = this.host.executionLease(input, localProjectId),
      store = this.host.store,
      meta = metas(store.meta)['session-' + scope.sessionId],
      doc = store.doc(scope.sessionId),
      view = mirror(doc, scope.sessionId);
    const history = structuredClone(view.getState().history);
    view.dispose();
    const agent = store.agents.binding(scope);
    assert(
      agent &&
        agent.id === meta.agentConfigId &&
        agent.machineId === scope.machineId &&
        agent.cliType === meta.cliType &&
        agent.agentType === meta.agentType,
      409,
      '来源会话没有可验证的固定 Agent 配置',
    );
    const nativeId = store.nativeSession(scope.sessionId, execution);
    const sourceVersion = hash(
      JSON.stringify([
        scopeKey(scope),
        vv(doc),
        store.searchSource(scope.sessionId)?.revision,
        execution,
        directoryIdentity(execution.rootPath),
        agent,
        nativeId,
      ]),
    );
    return {
      scope,
      execution,
      meta,
      doc,
      history,
      nativeId,
      agent,
      sourceVersion,
      capabilities: nativeId
        ? (store.forks.capabilities(scope, execution, nativeId, agent) ?? unavailable)
        : unavailable,
    };
  }
  async options(
    input: ForkOptionsRead,
    localProjectId?: string,
    checkpoint?: () => void,
  ): Promise<ForkOptionsResult> {
    checkpoint?.();
    const request = forkOptionsReadSchema.parse(input);
    assert(!this.busy.has(request.sessionId), 409, '来源会话正在处理 Fork');
    return this.host.serial(request.sessionId, async () => {
      this.busy.add(request.sessionId);
      try {
        checkpoint?.();
        const source = this.source(request, localProjectId);
        if (
          source.nativeId &&
          source.capabilities === unavailable &&
          this.idle(request.sessionId)
        ) {
          const session = await this.driver.open(
            source.agent,
            source.execution.rootPath,
            source.nativeId,
            { update: () => {}, permission: async () => ({ outcome: { outcome: 'cancelled' } }) },
            { assertCurrent: checkpoint },
          );
          let capabilities = session.forkCapabilities;
          try {
            assert(session.id === source.nativeId, 409, '来源原生会话未确认');
          } finally {
            await session.close();
          }
          checkpoint?.();
          assert(
            this.idle(request.sessionId) &&
              this.source(request, localProjectId).sourceVersion === source.sourceVersion,
            409,
            '来源会话已变化，请重新读取',
          );
          this.host.store.transaction(() =>
            this.host.store.forks.saveCapabilities(
              source.scope,
              source.execution,
              source.nativeId!,
              capabilities ?? unavailable,
              source.agent,
            ),
          );
        }
        return await this.readOptions(request, localProjectId, checkpoint);
      } finally {
        this.busy.delete(request.sessionId);
      }
    });
  }
  private async readOptions(
    input: ForkOptionsRead,
    localProjectId?: string,
    checkpoint?: () => void,
  ): Promise<ForkOptionsResult> {
    checkpoint?.();
    const request = forkOptionsReadSchema.parse(input),
      source = this.source(request, localProjectId),
      idle = this.idle(request.sessionId),
      cap = source.capabilities,
      currentAvailable = idle && !!source.nativeId && !!this.driver.fork && cap.sameDirectory;
    const all = source.history.filter((t) => t.role === 'assistant'),
      selected = request.turnId
        ? all.filter((t) => t.id === request.turnId)
        : all.slice(-FORK_LIMITS.turns);
    assert(!request.turnId || selected.length === 1, 404, '来源回合不存在');
    const turns = selected.map((t) => {
      const available =
        idle &&
        t.finished &&
        t.status === 'handled' &&
        cap.turnCutoff &&
        !!source.nativeId &&
        !!this.host.store.forks.anchor(
          source.scope,
          source.execution,
          source.nativeId,
          t.id,
          source.agent,
        );
      return {
        turnId: t.id,
        ordinal: all.indexOf(t) + 1,
        timestamp: t.timestamp,
        available,
        ...(!available ? { reason: '此回合没有可验证的已完成原生锚点，或来源会话尚未空闲' } : {}),
      };
    });
    let repository;
    if (cap.worktree) {
      repository = (
        await this.host.executionManager.read({
          gitVersion: 1,
          workspaceId: source.scope.workspaceId,
          localProjectId: source.scope.localProjectId,
          sessionId: source.scope.sessionId,
        })
      ).repository;
      assert(
        this.source(request, localProjectId).sourceVersion === source.sourceVersion,
        409,
        '来源会话已变化，请重新读取',
      );
    }
    checkpoint?.();
    const { turnId: _turn, ...responseScope } = request;
    return forkOptionsResultSchema.parse({
      ...responseScope,
      confirmed: true,
      sourceVersion: source.sourceVersion,
      execution: this.host.store.executions.info(source.scope),
      agent: { id: source.agent.id, name: source.agent.name, agentType: source.agent.agentType },
      capabilities: {
        sameDirectory: cap.sameDirectory && !!this.driver.fork,
        worktree: cap.worktree && !!this.driver.fork,
        turnCutoff: cap.turnCutoff && !!this.driver.fork,
        sameDirectoryReason: cap.sameDirectoryUnavailableReason,
        worktreeReason: cap.worktreeUnavailableReason,
        turnCutoffReason: cap.turnCutoffUnavailableReason,
      },
      currentAvailable,
      ...(!currentAvailable
        ? {
            currentReason: idle
              ? '来源没有可用的持久化原生上下文或 Fork 能力'
              : '请先完成、停止并保存来源会话',
          }
        : {}),
      turns,
      partial: all.length > turns.length,
      repository,
    });
  }
  private receipt(record: ForkRecord, phase: ForkReceipt['phase'], message?: string) {
    return forkReceiptSchema.parse({
      forkVersion: 1,
      workspaceId: record.scope.workspaceId,
      localProjectId: record.scope.localProjectId,
      sessionId: record.scope.sessionId,
      operationId: record.request.operationId,
      childSessionId: record.request.childSessionId,
      phase,
      confirmed: phase === 'accepted',
      ...(phase === 'accepted' ? { origin: record.origin } : {}),
      execution: this.host.store.executions.info(this.childScope(record)),
      ...(message ? { message: message.slice(0, FORK_LIMITS.message) } : {}),
    });
  }
  private saveReceipt(record: ForkRecord, result: ForkReceipt) {
    this.host.store.forks.save(record);
    this.host.store.journal.settleFork(scopeKey(record.scope), record.request, result);
    return result;
  }
  private reject(
    record: ForkRecord,
    message: string,
    phase: 'rejected' | 'abandoned' = 'rejected',
  ) {
    const store = this.host.store;
    return store.transaction(() => {
      if (record.request.directory.kind === 'same-directory') {
        const execution = store.executions.get(this.childScope(record));
        if (execution?.operationId === record.request.operationId)
          store.executions.removeRejected(this.childScope(record), record.request.operationId);
      }
      const next = { ...record, phase };
      return this.saveReceipt(next, this.receipt(next, phase, message));
    });
  }
  private unknown(
    record: ForkRecord,
    message = 'Fork 结果尚未确认；请查询原操作。不会重复创建原生会话。',
  ) {
    const result = this.receipt(record, 'unknown', message);
    try {
      return this.host.store.transaction(() => this.saveReceipt(record, result));
    } catch {
      return result;
    }
  }
  private current(record: ForkRecord, checkpoint?: () => void) {
    checkpoint?.();
    this.host.ensureConnected();
    this.assertAgentBinding(record);
    const source = this.source(record.scope);
    assert(
      this.idle(record.scope.sessionId) &&
        source.sourceVersion === record.request.expectedSourceVersion,
      409,
      '来源会话已变化，请重新选择 Fork 截止点',
    );
    assert(
      isDeepStrictEqual(source.execution, record.sourceExecution) &&
        source.nativeId === record.sourceNativeId,
      409,
      '来源原生执行范围已变化',
    );
    return source;
  }
  private prepareAction(record: ForkRecord): GitPrepare {
    assert(record.request.directory.kind === 'worktree', 409, '工作目录计划无效');
    const { baseBranch, expectedOid, newBranch } = record.request.directory;
    return {
      gitVersion: 1,
      workspaceId: record.scope.workspaceId,
      localProjectId: record.scope.localProjectId,
      sessionId: record.request.childSessionId,
      operationId: record.gitOperationId!,
      action: 'prepare',
      expectedRevision: 0,
      baseBranch,
      expectedOid,
      newBranch,
    };
  }
  private targetCurrent(record: ForkRecord, checkpoint?: () => void) {
    checkpoint?.();
    assert(record.targetExecution && record.targetDirectory, 409, 'Fork 子会话目录身份尚未确认');
    const current = this.host.executionLease(this.childScope(record), undefined, true);
    assert(
      isDeepStrictEqual(current, record.targetExecution) &&
        isDeepStrictEqual(directoryIdentity(current.rootPath), record.targetDirectory),
      409,
      'Fork 子会话工作目录已变化',
    );
    this.assertAgentBinding(record);
    return current;
  }
  private assertAgentBinding(record: ForkRecord) {
    const agents = this.host.store.agents;
    agents.assertCurrent(record.scope, record.agent);
    const child = agents.binding(this.childScope(record));
    assert(!child || isDeepStrictEqual(child, record.agent), 409, 'Fork 子会话的 Agent 配置不匹配');
  }
  private nativeResult(record: ForkRecord, nativeId: string) {
    assert(
      typeof nativeId === 'string' &&
        nativeId.length > 0 &&
        nativeId.length <= 500 &&
        !/[\s\x00-\x1f\x7f]/u.test(nativeId) &&
        nativeId !== record.sourceNativeId &&
        (!record.nativeId || record.nativeId === nativeId),
      502,
      'Agent 未返回可确认的独立原生会话',
    );
  }
  async action(
    input: SessionFork,
    localProjectId?: string,
    checkpoint?: () => void,
  ): Promise<ForkReceipt> {
    checkpoint?.();
    const request = sessionForkSchema.parse(input);
    assert(
      !this.host.executionManager.busy.has(request.childSessionId),
      409,
      '子会话正在处理 Git 操作',
    );
    assert(
      !this.busy.has(request.sessionId) && !this.busy.has(request.childSessionId),
      409,
      '此会话正在处理 Fork',
    );
    this.busy.add(request.sessionId);
    this.busy.add(request.childSessionId);
    try {
      return await this.host.serial(request.sessionId, async () => {
        checkpoint?.();
        const store = this.host.store,
          sourceLease = this.host.projectLease(request, localProjectId),
          { rootPath: _root, ...scope } = sourceLease;
        this.host.projectRootLease(
          { ...request, sessionId: request.childSessionId },
          localProjectId,
        );
        const previous = store.journal.lookup(scopeKey(scope), request);
        if (
          previous &&
          ['fork-accepted', 'fork-rejected', 'fork-abandoned'].includes(previous.phase)
        )
          return forkReceiptSchema.parse(JSON.parse(previous.result));
        let record = store.forks.record(request.operationId);
        if (previous) {
          assert(record && scopeKey(record.scope) === scopeKey(scope), 409, 'Fork 预留记录不可用');
        } else {
          assert(
            !store.forks.child(request.childSessionId) &&
              !store.searchSource(request.childSessionId) &&
              !store.hasNativeSession(request.childSessionId) &&
              !metas(store.meta)['session-' + request.childSessionId] &&
              !store.executions.get({ ...scope, sessionId: request.childSessionId }),
            409,
            'Fork 必须使用尚未使用的子会话编号',
          );
          const source = this.source(request, localProjectId);
          assert(
            this.idle(request.sessionId) && source.nativeId && this.driver.fork,
            409,
            '来源会话必须空闲且具有持久化原生上下文',
          );
          assert(
            source.sourceVersion === request.expectedSourceVersion &&
              source.execution.executionRevision === request.expectedExecutionRevision,
            409,
            '来源会话已变化，请重新读取',
          );
          assert(
            source.capabilities.sameDirectory &&
              (request.directory.kind === 'same-directory' || source.capabilities.worktree),
            409,
            '此 Agent 不支持所选 Fork 目录模式',
          );
          let anchor: AgentForkAnchor | undefined;
          if (request.cutoff.kind === 'turn') {
            const turn = source.history.find(
              (t) => t.id === (request.cutoff as { turnId: string }).turnId,
            );
            anchor = store.forks.anchor(
              scope,
              source.execution,
              source.nativeId,
              request.cutoff.turnId,
              source.agent,
            );
            assert(
              source.capabilities.turnCutoff &&
                turn?.role === 'assistant' &&
                turn.finished &&
                turn.status === 'handled' &&
                anchor,
              409,
              '所选回合没有可验证的原生锚点',
            );
          }
          const origin: ForkOrigin = {
            version: 1,
            sourceSessionId: request.sessionId,
            sourceVersion: source.sourceVersion,
            sourceTitle: String(source.meta.title ?? '').slice(0, 200),
            cutoff: request.cutoff,
            directory: request.directory.kind,
            createdAt: new Date().toISOString(),
            ...(request.directory.kind === 'worktree'
              ? { baseOid: request.directory.expectedOid, branch: request.directory.newBranch }
              : {}),
          };
          record = {
            scope,
            request,
            origin,
            sourceExecution: source.execution,
            sourceNativeId: source.nativeId,
            agent: source.agent,
            capabilities: source.capabilities,
            anchor,
            phase: 'preparing',
            ...(request.directory.kind === 'worktree'
              ? {
                  gitOperationId:
                    'fork_git_' +
                    createHash('sha256')
                      .update(scopeKey(scope) + request.operationId)
                      .digest('hex'),
                }
              : {}),
          };
          store.transaction(() => {
            checkpoint?.();
            store.reserveAttachmentScope({ ...scope, sessionId: request.childSessionId });
            store.journal.stageFork(scopeKey(scope), request);
            store.forks.stage(record!);
            if (request.directory.kind === 'same-directory') {
              const original = store.executions.get(scope);
              if (original)
                store.executions.put({
                  ...original,
                  scope: { ...scope, sessionId: request.childSessionId },
                  operationId: request.operationId,
                });
            }
          });
        }
        this.host.executionManager.busy.add(request.sessionId);
        try {
          this.assertAgentBinding(record!);
          if (record!.phase === 'accepted' || record!.phase === 'rejected')
            throw new AppError(409, 'Fork 回执状态不一致');
          if (record!.phase === 'dispatched')
            return record!.nativeId
              ? await this.recoverNative(record!, checkpoint)
              : this.unknown(record!);
          if (record!.phase === 'returned') return this.accept(record!, checkpoint);
          if (request.directory.kind === 'worktree') {
            const git = this.prepareAction(record!);
            if (!store.journal.has(git.operationId)) this.current(record!, checkpoint);
            const result = await this.host.executionManager.action(git, localProjectId, checkpoint);
            if (result.phase === 'unknown')
              return this.unknown(
                record!,
                '工作目录操作尚未确认；请手动查询原 Fork 操作，原生 Fork 尚未调用。',
              );
            if (result.phase === 'rejected' || result.phase === 'abandoned')
              return this.reject(record!, result.message ?? '工作目录创建被拒绝，原生 Fork 未调用');
          }
          this.current(record!, checkpoint);
          const targetExecution = this.host.executionLease(
            this.childScope(record!),
            localProjectId,
            true,
          );
          record = {
            ...record!,
            targetExecution,
            targetDirectory: directoryIdentity(targetExecution.rootPath),
            phase: 'dispatched',
          };
          store.transaction(() => store.forks.save(record!));
          const result = await this.driver.fork!(record.agent, {
            sourceNativeId: record.sourceNativeId,
            sourceCwd: record.sourceExecution.rootPath,
            targetCwd: targetExecution.rootPath,
            anchor: record.anchor,
            assertCurrent: () => {
              this.current(record!, checkpoint);
              this.targetCurrent(record!, checkpoint);
            },
            onNativeId: (nativeId) => {
              this.nativeResult(record!, nativeId);
              record = { ...record!, nativeId };
              store.transaction(() => store.forks.save(record!));
            },
          });
          this.nativeResult(record, result.nativeId);
          record = { ...record, nativeId: result.nativeId, phase: 'returned' };
          store.transaction(() => store.forks.save(record!));
          return this.accept(record, checkpoint);
        } catch (error) {
          // Only a pre-native stage, or the driver's explicit proof that no fork
          // call started, can be safely rejected and release the child reservation.
          let durable = store.forks.record(request.operationId) ?? record!;
          if (
            record!.nativeId &&
            isDeepStrictEqual(record!.request, durable.request) &&
            isDeepStrictEqual(record!.targetExecution, durable.targetExecution) &&
            isDeepStrictEqual(record!.targetDirectory, durable.targetDirectory) &&
            scopeKey(record!.scope) === scopeKey(durable.scope)
          )
            durable = {
              ...durable,
              nativeId: record!.nativeId,
              phase: record!.phase === 'returned' ? 'returned' : 'dispatched',
            };
          if (
            !durable.nativeId &&
            (durable.phase === 'preparing' || (error instanceof AppError && error.rejected))
          )
            return this.reject(
              durable,
              error instanceof AppError ? error.message : 'Fork 前置检查失败，原生会话尚未创建',
            );
          return this.unknown(durable);
        } finally {
          this.host.executionManager.busy.delete(request.sessionId);
        }
      });
    } finally {
      this.busy.delete(request.sessionId);
      this.busy.delete(request.childSessionId);
    }
  }
  async operations(
    input: ForkOperation,
    localProjectId?: string,
    checkpoint?: () => void,
  ): Promise<ForkOperationResult> {
    const operation = forkOperationSchema.parse(input),
      request = operation.request;
    checkpoint?.();
    assert(
      !this.busy.has(request.sessionId) &&
        !this.busy.has(request.childSessionId) &&
        !this.host.executionManager.busy.has(request.childSessionId),
      409,
      '原 Fork 或工作目录仍在执行，请等待原请求结束',
    );
    this.busy.add(request.sessionId);
    this.busy.add(request.childSessionId);
    try {
      return await this.host.serial(request.sessionId, async () => {
        const store = this.host.store,
          { rootPath: _root, ...scope } = this.host.projectLease(request, localProjectId);
        const current = () => {
          checkpoint?.();
          const { rootPath: _root, ...latest } = this.host.projectLease(request, localProjectId);
          assert(isDeepStrictEqual(scope, latest), 409, '原 Fork 所属范围已变化');
        };
        current();
        this.host.projectRootLease(
          { ...request, sessionId: request.childSessionId },
          localProjectId,
        );
        const base = {
          forkVersion: 1 as const,
          workspaceId: request.workspaceId,
          localProjectId: request.localProjectId,
          sessionId: request.sessionId,
          operationId: request.operationId,
          action: operation.action,
          requestVersion: hash(JSON.stringify(request)),
          confirmed: true as const,
        };
        const result = (receipt?: ForkReceipt) => {
          current();
          return forkOperationResultSchema.parse(
            receipt ? { ...base, found: true, receipt } : { ...base, found: false },
          );
        };
        const previous = store.journal.lookup(scopeKey(scope), request);
        if (!previous) {
          if (operation.action === 'inspect') return result();
          const receipt = forkReceiptSchema.parse({
            forkVersion: 1,
            workspaceId: request.workspaceId,
            localProjectId: request.localProjectId,
            sessionId: request.sessionId,
            operationId: request.operationId,
            childSessionId: request.childSessionId,
            phase: 'abandoned',
            confirmed: false,
            message: '原 Fork 请求已封存，不会执行迟到的同编号请求。',
          });
          store.transaction(() => {
            current();
            store.journal.stageFork(scopeKey(scope), request);
            store.journal.settleFork(scopeKey(scope), request, receipt);
          });
          return result(receipt);
        }
        assert(previous.phase.startsWith('fork-'), 409, '原操作编号属于另一类操作');
        if (['fork-accepted', 'fork-rejected', 'fork-abandoned'].includes(previous.phase))
          return result(forkReceiptSchema.parse(JSON.parse(previous.result)));
        const record = store.forks.record(request.operationId);
        assert(
          record &&
            isDeepStrictEqual(record.request, request) &&
            scopeKey(record.scope) === scopeKey(scope),
          409,
          'Fork 原操作记录不匹配',
        );
        this.assertAgentBinding(record);
        if (record.phase === 'returned') return result(this.accept(record, checkpoint));
        if (record.phase === 'dispatched')
          return result(
            this.unknown(
              record,
              '原生 Fork 已派发，核查不会启动或载入 Agent；请在原映射明确重试已知结果，未知结果仍保留保护。',
            ),
          );
        assert(record.phase === 'preparing', 409, 'Fork 原操作阶段不可验证');
        if (request.directory.kind === 'worktree') {
          const git = await this.host.executionManager.operations(
            { action: operation.action, request: this.prepareAction(record) },
            localProjectId,
            checkpoint,
          );
          current();
          if (git.found && git.receipt.phase === 'unknown')
            return result(
              this.unknown(record, '原工作目录结果尚未确认，未封存或重复执行原生 Fork。'),
            );
        }
        if (operation.action === 'abandon')
          return result(
            this.reject(
              record,
              '原生 Fork 尚未派发，原请求已封存；已创建的工作目录仍保留，请明确检查和清理。',
              'abandoned',
            ),
          );
        return result(
          this.unknown(record, '原生 Fork 尚未派发；核查不会继续创建，需明确重试原操作或封存。'),
        );
      });
    } finally {
      this.busy.delete(request.sessionId);
      this.busy.delete(request.childSessionId);
    }
  }
  private async recoverNative(record: ForkRecord, checkpoint?: () => void): Promise<ForkReceipt> {
    assert(record.nativeId && record.targetExecution, 409, '缺少已知原生 Fork 结果');
    const current = () => {
      checkpoint?.();
      this.host.projectLease(record.scope);
      this.targetCurrent(record, checkpoint);
    };
    current();
    const session = await this.driver.open(
      record.agent,
      record.targetExecution.rootPath,
      record.nativeId,
      { update: () => {}, permission: async () => ({ outcome: { outcome: 'cancelled' } }) },
      { assertCurrent: current },
    );
    try {
      current();
      assert(session.id === record.nativeId, 409, 'Agent 未确认已知的 Fork 子会话');
    } finally {
      await session.close();
    }
    current();
    const recovered = { ...record, phase: 'returned' as const };
    this.host.store.transaction(() => this.host.store.forks.save(recovered));
    return this.accept(recovered, checkpoint);
  }
  private accept(record: ForkRecord, checkpoint?: () => void): ForkReceipt {
    checkpoint?.();
    const store = this.host.store,
      scope = this.childScope(record);
    this.host.projectLease(record.scope);
    assert(record.nativeId && record.targetExecution, 409, '缺少已确认的原生 Fork 结果');
    const current = this.targetCurrent(record, checkpoint);
    assert(
      !store.searchSource(scope.sessionId) && !metas(store.meta)['session-' + scope.sessionId],
      409,
      'Fork 子会话已被使用',
    );
    const next = Flock.fromFile(store.meta.exportFile()),
      doc = store.doc(scope.sessionId),
      view = mirror(doc, scope.sessionId);
    view.setState((state) => {
      state.session.id = scope.sessionId;
      state.history.splice(0);
    });
    view.dispose();
    doc.commit();
    putMeta(next, 'session-' + scope.sessionId, {
      id: scope.sessionId,
      machineId: scope.machineId,
      userId: scope.userId,
      createdAt: record.origin.createdAt,
      cliType: record.agent.cliType,
      agentType: record.agent.agentType,
      agentConfigId: record.agent.id,
      project: { kind: 'local', localProjectId: scope.localProjectId },
      status: { type: 'idle' },
      isArchived: false,
      isPinned: false,
      metadataRevision: 0,
      title: record.origin.sourceTitle ? record.origin.sourceTitle + ' · Fork' : 'Fork 会话',
      titleSource: 'host',
      forkOrigin: record.origin,
      lastMessageAt: Date.parse(record.origin.createdAt),
    });
    const previous = store.meta;
    try {
      return store.transaction(() => {
        checkpoint?.();
        store.agents.bind(scope, record.agent);
        store.meta = next;
        store.setNativeSession(scope.sessionId, record.nativeId!, current);
        store.forks.saveCapabilities(
          scope,
          current,
          record.nativeId!,
          record.capabilities,
          record.agent,
        );
        store.persist(scope.sessionId, doc);
        const accepted = { ...record, phase: 'accepted' as const };
        return this.saveReceipt(accepted, this.receipt(accepted, 'accepted'));
      });
    } catch (error) {
      store.meta = previous;
      throw error;
    }
  }
}
